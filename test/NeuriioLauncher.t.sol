// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAscendAdapter} from "../src/launch/IAscendAdapter.sol";
import {NeuriioLauncher} from "../src/launch/NeuriioLauncher.sol";

contract TestToken is ERC20("Test", "TEST") {
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Stands in for the real adapter until Ascend shares its contracts. Launches real tokens and "buys" at 100 tokens per USDC
/// unit, refunding `refundBps` of the USDC.
contract MockAdapter is IAscendAdapter {
    IERC20 public immutable usdc;
    uint256 public refundBps;
    bool public payNothing;

    address[] internal _lastCreators;
    string public lastName;
    string public lastSymbol;
    address public forcedToken;

    constructor(IERC20 usdc_) {
        usdc = usdc_;
    }

    function set(uint256 refundBps_, bool payNothing_) external {
        refundBps = refundBps_;
        payNothing = payNothing_;
    }

    function force(address token) external {
        forcedToken = token;
    }

    function lastCreators() external view returns (address[] memory) {
        return _lastCreators;
    }

    function launch(address[] calldata creators, string calldata name, string calldata symbol, bytes calldata)
        external
        returns (address token, bytes32 pool)
    {
        _lastCreators = creators;
        lastName = name;
        lastSymbol = symbol;
        token = forcedToken != address(0) ? forcedToken : address(new TestToken());
        pool = keccak256(abi.encode(token));
    }

    function firstBuy(address token, bytes32, address buyer, uint256 quoteIn) external {
        uint256 refund = quoteIn * refundBps / 10_000;
        if (refund > 0) usdc.transfer(buyer, refund);
        usdc.transfer(address(0x900D), quoteIn - refund); // to the pool
        if (!payNothing) TestToken(token).mint(buyer, (quoteIn - refund) * 100);
    }
}

contract ZeroAdapter is IAscendAdapter {
    function launch(address[] calldata, string calldata, string calldata, bytes calldata)
        external
        pure
        returns (address, bytes32)
    {
        return (address(0), bytes32(0));
    }

    function firstBuy(address, bytes32, address, uint256) external {}
}

/// Calls back into the launcher mid-launch.
contract ReentrantAdapter is IAscendAdapter {
    NeuriioLauncher public launcher;
    NeuriioLauncher.LaunchPass internal _pass;
    bytes internal _sig;

    function arm(NeuriioLauncher l, NeuriioLauncher.LaunchPass calldata pass, bytes calldata sig) external {
        launcher = l;
        _pass = pass;
        _sig = sig;
    }

    function launch(address[] calldata, string calldata, string calldata, bytes calldata)
        external
        returns (address, bytes32)
    {
        return (launcher.launch(_pass, _sig, 0, 0), bytes32(0));
    }

    function firstBuy(address, bytes32, address, uint256) external {}
}

contract NeuriioLauncherTest is Test {
    NeuriioLauncher internal launcher;
    MockAdapter internal adapter;
    TestToken internal usdc;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    uint256 internal signerKey = 0xA11CE;
    uint64 internal constant ALICE_X = 111;
    uint64 internal constant BOB_X = 222;
    bytes32 internal constant PROFILE = keccak256("profile");

    function setUp() public {
        usdc = new TestToken();
        launcher = new NeuriioLauncher(owner, usdc, vm.addr(signerKey), guardian);
        adapter = new MockAdapter(usdc);
        vm.startPrank(owner);
        launcher.setAdapter(adapter);
        vm.stopPrank();
    }

    function _pass(address creator, uint64 xId, string memory handle)
        internal
        view
        returns (NeuriioLauncher.LaunchPass memory)
    {
        return NeuriioLauncher.LaunchPass(creator, xId, handle, 1, PROFILE, "", block.timestamp + 1 hours);
    }

    function _sign(NeuriioLauncher.LaunchPass memory pass, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, launcher.hashLaunchPass(pass));
        return abi.encodePacked(r, s, v);
    }

    function _launch(address creator, uint64 xId, string memory handle) internal returns (address) {
        NeuriioLauncher.LaunchPass memory pass = _pass(creator, xId, handle);
        bytes memory sig = _sign(pass, signerKey);
        vm.prank(creator);
        return launcher.launch(pass, sig, 0, 0);
    }

    function _expectLaunchRevert(address creator, uint64 xId, string memory handle, bytes4 err) internal {
        NeuriioLauncher.LaunchPass memory pass = _pass(creator, xId, handle);
        bytes memory sig = _sign(pass, signerKey);
        vm.prank(creator);
        vm.expectRevert(err);
        launcher.launch(pass, sig, 0, 0);
    }

    // ------------------------------------------------------------------ launching

    function test_launchRecordsEverything() public {
        address token = _launch(alice, ALICE_X, "Alice_1");

        assertTrue(launcher.isLaunched(token));
        assertEq(launcher.creatorOf(token), alice);
        assertEq(launcher.tokenOfXUser(ALICE_X), token);
        assertEq(launcher.tokenOfCreator(alice), token);
        assertEq(launcher.tokenOfHandle(keccak256("alice_1")), token);
        assertEq(launcher.allTokensLength(), 1);
        assertEq(launcher.allTokens(0), token);

        NeuriioLauncher.Launch memory l = launcher.launchOf(token);
        assertEq(l.creator, alice);
        assertEq(l.xUserId, ALICE_X);
        assertEq(uint8(l.category), 1);
        assertEq(l.profileHash, PROFILE);
        assertEq(l.pool, keccak256(abi.encode(token)));
        assertEq(l.handle, "Alice_1");
    }

    function test_adapterGetsCreatorNameAndTicker() public {
        _launch(alice, ALICE_X, "Alice_1");
        assertEq(adapter.lastCreators().length, 1);
        assertEq(adapter.lastCreators()[0], alice);
        assertEq(adapter.lastName(), "@Alice_1");
        assertEq(adapter.lastSymbol(), "ALICE_1");
    }

    function test_launchEmits() public {
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        address token = address(new TestToken());
        adapter.force(token);
        vm.expectEmit(address(launcher));
        emit NeuriioLauncher.Launched(
            token, alice, ALICE_X, "alice", NeuriioLauncher.Category.MemeTrader, PROFILE, keccak256(abi.encode(token))
        );
        vm.prank(alice);
        launcher.launch(pass, sig, 0, 0);
    }

    function test_unlaunchedTokenIsUnknown() public view {
        assertFalse(launcher.isLaunched(address(0xBEEF)));
        assertEq(launcher.creatorOf(address(0xBEEF)), address(0));
    }

    // ------------------------------------------------------------------ the pass

    function test_expiredPassReverts() public {
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        vm.warp(pass.deadline + 1);
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.Expired.selector);
        launcher.launch(pass, sig, 0, 0);
    }

    function test_someoneElsesPassReverts() public {
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        vm.prank(bob);
        vm.expectRevert(NeuriioLauncher.NotPassHolder.selector);
        launcher.launch(pass, sig, 0, 0);
    }

    function test_wrongSignerReverts() public {
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, 0xBAD);
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
        launcher.launch(pass, sig, 0, 0);
    }

    function test_alteredPassReverts() public {
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        pass.handle = "elonmusk";
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
        launcher.launch(pass, sig, 0, 0);
    }

    function test_badCategoryReverts() public {
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        pass.category = 6;
        bytes memory sig = _sign(pass, signerKey);
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
        launcher.launch(pass, sig, 0, 0);
    }

    function test_zeroXUserReverts() public {
        _expectLaunchRevert(alice, 0, "alice", NeuriioLauncher.InvalidPass.selector);
    }

    function test_rotatedSignerKillsOldPasses() public {
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        vm.prank(owner);
        launcher.setLaunchSigner(vm.addr(0xB0B));
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
        launcher.launch(pass, sig, 0, 0);
    }

    // ------------------------------------------------------------------ one token each

    function test_oneTokenPerXAccount() public {
        _launch(alice, ALICE_X, "alice");
        _expectLaunchRevert(bob, ALICE_X, "bob", NeuriioLauncher.AlreadyLaunched.selector);
    }

    function test_oneTokenPerWallet() public {
        _launch(alice, ALICE_X, "alice");
        _expectLaunchRevert(alice, BOB_X, "bob", NeuriioLauncher.AlreadyLaunched.selector);
    }

    function test_oneTokenPerHandleIgnoringCase() public {
        _launch(alice, ALICE_X, "alice");
        _expectLaunchRevert(bob, BOB_X, "ALICE", NeuriioLauncher.AlreadyLaunched.selector);
    }

    function test_samePassCantLaunchTwice() public {
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        vm.startPrank(alice);
        launcher.launch(pass, sig, 0, 0);
        vm.expectRevert(NeuriioLauncher.AlreadyLaunched.selector);
        launcher.launch(pass, sig, 0, 0);
        vm.stopPrank();
    }

    function test_twoPeopleCanBothLaunch() public {
        address a = _launch(alice, ALICE_X, "alice");
        address b = _launch(bob, BOB_X, "bob");
        assertTrue(a != b);
        assertEq(launcher.allTokensLength(), 2);
    }

    // ------------------------------------------------------------------ handles and tickers

    function test_badHandlesRevert() public {
        string[4] memory bad = ["", "sixteen_chars_xx", "has space", "emoji\xf0\x9f\x98\x80"];
        for (uint256 i; i < bad.length; ++i) {
            _expectLaunchRevert(alice, ALICE_X, bad[i], NeuriioLauncher.InvalidMetadata.selector);
        }
    }

    function test_longestHandleWorks() public {
        _launch(alice, ALICE_X, "fifteen_chars_x");
        assertEq(adapter.lastSymbol(), "FIFTEEN_CHARS_X");
    }

    function test_reservedTickersRevertInAnyCase() public {
        _expectLaunchRevert(alice, ALICE_X, "USDC", NeuriioLauncher.TickerIsReserved.selector);
        _expectLaunchRevert(alice, ALICE_X, "neuriio", NeuriioLauncher.TickerIsReserved.selector);
    }

    function test_ownerCanReserveAndFreeTickers() public {
        string[] memory tickers = new string[](1);
        tickers[0] = "ALICE";
        vm.prank(owner);
        launcher.setReservedTickers(tickers, true);
        _expectLaunchRevert(alice, ALICE_X, "alice", NeuriioLauncher.TickerIsReserved.selector);
        vm.prank(owner);
        launcher.setReservedTickers(tickers, false);
        _launch(alice, ALICE_X, "alice");
    }

    // ------------------------------------------------------------------ the adapter

    function test_noAdapterStopsLaunches() public {
        vm.prank(owner);
        launcher.setAdapter(IAscendAdapter(address(0)));
        _expectLaunchRevert(alice, ALICE_X, "alice", NeuriioLauncher.NoAdapter.selector);
    }

    function test_adapterReturningNoTokenReverts() public {
        ZeroAdapter zero = new ZeroAdapter();
        vm.prank(owner);
        launcher.setAdapter(zero);
        _expectLaunchRevert(alice, ALICE_X, "alice", NeuriioLauncher.BadAdapterToken.selector);
    }

    function test_adapterReturningALaunchedTokenReverts() public {
        address token = _launch(alice, ALICE_X, "alice");
        adapter.force(token);
        _expectLaunchRevert(bob, BOB_X, "bob", NeuriioLauncher.BadAdapterToken.selector);
        assertEq(launcher.creatorOf(token), alice);
    }

    function test_adapterCantReenter() public {
        ReentrantAdapter evil = new ReentrantAdapter();
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        evil.arm(launcher, pass, sig);
        vm.prank(owner);
        launcher.setAdapter(evil);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        launcher.launch(pass, sig, 0, 0);
    }

    function test_swappingAdapterKeepsIdentity() public {
        _launch(alice, ALICE_X, "alice");
        MockAdapter next = new MockAdapter(usdc);
        vm.prank(owner);
        launcher.setAdapter(next);
        _expectLaunchRevert(alice, ALICE_X, "alice", NeuriioLauncher.AlreadyLaunched.selector);
    }

    // ------------------------------------------------------------------ FTFs

    function _ftfPass(string memory name, string memory ticker) internal returns (NeuriioLauncher.FtfPass memory) {
        return NeuriioLauncher.FtfPass(
            alice,
            name,
            ticker,
            [ALICE_X, BOB_X, 333, 444],
            [alice, bob, makeAddr("carol"), makeAddr("dan")],
            PROFILE,
            "",
            block.timestamp + 1 hours
        );
    }

    function _signFtf(NeuriioLauncher.FtfPass memory pass, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, launcher.hashFtfPass(pass));
        return abi.encodePacked(r, s, v);
    }

    function _launchFtf(NeuriioLauncher.FtfPass memory pass) internal returns (address) {
        bytes memory sig = _signFtf(pass, signerKey);
        vm.prank(pass.founder);
        return launcher.launchFtf(pass, sig, 0, 0);
    }

    function _expectFtfRevert(NeuriioLauncher.FtfPass memory pass, bytes4 err) internal {
        bytes memory sig = _signFtf(pass, signerKey);
        vm.prank(pass.founder);
        vm.expectRevert(err);
        launcher.launchFtf(pass, sig, 0, 0);
    }

    function test_ftfRecordsEverything() public {
        NeuriioLauncher.FtfPass memory pass = _ftfPass("Degen Den", "DEN");
        address token = _launchFtf(pass);

        assertTrue(launcher.isLaunched(token));
        assertTrue(launcher.isFtf(token));
        assertEq(launcher.creatorOf(token), alice);
        assertEq(launcher.tokenOfFtfTicker(keccak256("DEN")), token);
        assertEq(launcher.allTokensLength(), 1);

        NeuriioLauncher.Ftf memory f = launcher.ftf(token);
        assertEq(f.name, "Degen Den");
        assertEq(f.memberXIds[3], 444);
        assertEq(f.members[1], bob);
        assertEq(launcher.launchOf(token).profileHash, PROFILE);

        address[] memory creators = launcher.creatorsOf(token);
        assertEq(creators.length, 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(creators[i], pass.members[i]);
        }
    }

    function test_ftfAdapterGetsAllMembersNameAndTicker() public {
        NeuriioLauncher.FtfPass memory pass = _ftfPass("Degen Den", "DEN");
        _launchFtf(pass);
        assertEq(adapter.lastCreators().length, 4);
        assertEq(adapter.lastCreators()[3], pass.members[3]);
        assertEq(adapter.lastName(), "Degen Den");
        assertEq(adapter.lastSymbol(), "DEN");
    }

    function test_ftfEmits() public {
        NeuriioLauncher.FtfPass memory pass = _ftfPass("Degen Den", "DEN");
        bytes memory sig = _signFtf(pass, signerKey);
        address token = address(new TestToken());
        adapter.force(token);
        vm.expectEmit(address(launcher));
        emit NeuriioLauncher.FtfLaunched(
            token, alice, "Degen Den", "DEN", pass.memberXIds, pass.members, PROFILE, keccak256(abi.encode(token))
        );
        vm.prank(alice);
        launcher.launchFtf(pass, sig, 0, 0);
    }

    function test_personalTokenHasOneCreatorAndIsntAnFtf() public {
        address token = _launch(alice, ALICE_X, "alice");
        assertFalse(launcher.isFtf(token));
        assertEq(launcher.creatorsOf(token).length, 1);
        assertEq(launcher.creatorsOf(token)[0], alice);
        assertEq(launcher.creatorsOf(address(0xBEEF)).length, 0);
    }

    function test_ftfDoesntUseUpPersonalLaunch() public {
        _launchFtf(_ftfPass("Degen Den", "DEN"));
        address token = _launch(alice, ALICE_X, "alice");
        assertFalse(launcher.isFtf(token));
    }

    function test_personalLaunchDoesntBlockAnFtf() public {
        _launch(alice, ALICE_X, "alice");
        _launchFtf(_ftfPass("Degen Den", "DEN"));
    }

    function test_ftfTickerIsUniqueAmongFtfs() public {
        _launchFtf(_ftfPass("Degen Den", "DEN"));
        _expectFtfRevert(_ftfPass("Other Den", "DEN"), NeuriioLauncher.TickerTaken.selector);
    }

    function test_ftfTickerCanMatchAPersonalOne() public {
        _launch(bob, BOB_X, "den");
        _launchFtf(_ftfPass("Degen Den", "DEN"));
    }

    function test_ftfReservedTickerReverts() public {
        _expectFtfRevert(_ftfPass("Degen Den", "USDC"), NeuriioLauncher.TickerIsReserved.selector);
    }

    function test_ftfExpiredPassReverts() public {
        NeuriioLauncher.FtfPass memory pass = _ftfPass("Degen Den", "DEN");
        bytes memory sig = _signFtf(pass, signerKey);
        vm.warp(pass.deadline + 1);
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.Expired.selector);
        launcher.launchFtf(pass, sig, 0, 0);
    }

    function test_ftfOnlyFounderSends() public {
        NeuriioLauncher.FtfPass memory pass = _ftfPass("Degen Den", "DEN");
        bytes memory sig = _signFtf(pass, signerKey);
        vm.prank(bob);
        vm.expectRevert(NeuriioLauncher.NotPassHolder.selector);
        launcher.launchFtf(pass, sig, 0, 0);
    }

    function test_ftfFounderMustBeFirstMember() public {
        NeuriioLauncher.FtfPass memory pass = _ftfPass("Degen Den", "DEN");
        pass.members[0] = makeAddr("erin");
        _expectFtfRevert(pass, NeuriioLauncher.NotPassHolder.selector);
    }

    function test_ftfWrongSignerReverts() public {
        NeuriioLauncher.FtfPass memory pass = _ftfPass("Degen Den", "DEN");
        bytes memory sig = _signFtf(pass, 0xBAD);
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
        launcher.launchFtf(pass, sig, 0, 0);
    }

    function test_ftfSwappedMemberBreaksTheSignature() public {
        NeuriioLauncher.FtfPass memory pass = _ftfPass("Degen Den", "DEN");
        bytes memory sig = _signFtf(pass, signerKey);
        pass.members[3] = makeAddr("attacker");
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
        launcher.launchFtf(pass, sig, 0, 0);
    }

    function test_ftfBadMembersRevert() public {
        NeuriioLauncher.FtfPass memory pass = _ftfPass("Degen Den", "DEN");
        pass.memberXIds[2] = 0;
        _expectFtfRevert(pass, NeuriioLauncher.InvalidMembers.selector);
        pass = _ftfPass("Degen Den", "DEN");
        pass.members[2] = address(0);
        _expectFtfRevert(pass, NeuriioLauncher.InvalidMembers.selector);
        pass = _ftfPass("Degen Den", "DEN");
        pass.memberXIds[3] = pass.memberXIds[0];
        _expectFtfRevert(pass, NeuriioLauncher.InvalidMembers.selector);
        pass = _ftfPass("Degen Den", "DEN");
        pass.members[3] = pass.members[1];
        _expectFtfRevert(pass, NeuriioLauncher.InvalidMembers.selector);
    }

    function test_ftfBadNamesAndTickersRevert() public {
        string[5] memory names = ["", " Den", "Den ", "Two  Spaces", "Bad!Name"];
        for (uint256 i; i < names.length; ++i) {
            _expectFtfRevert(_ftfPass(names[i], "DEN"), NeuriioLauncher.InvalidMetadata.selector);
        }
        string[4] memory tickers = ["", "A", "ELEVENCHARS", "den"];
        for (uint256 i; i < tickers.length; ++i) {
            _expectFtfRevert(_ftfPass("Degen Den", tickers[i]), NeuriioLauncher.InvalidMetadata.selector);
        }
    }

    function test_ftfStopsWithPauseAndWithoutAdapter() public {
        vm.prank(guardian);
        launcher.pause();
        _expectFtfRevert(_ftfPass("Degen Den", "DEN"), Pausable.EnforcedPause.selector);
        vm.startPrank(owner);
        launcher.unpause();
        launcher.setAdapter(IAscendAdapter(address(0)));
        vm.stopPrank();
        _expectFtfRevert(_ftfPass("Degen Den", "DEN"), NeuriioLauncher.NoAdapter.selector);
    }

    function test_ftfAdapterReturningALaunchedTokenReverts() public {
        address token = _launch(bob, BOB_X, "bob");
        adapter.force(token);
        _expectFtfRevert(_ftfPass("Degen Den", "DEN"), NeuriioLauncher.BadAdapterToken.selector);
    }

    // ------------------------------------------------------------------ first buy

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(launcher), amount);
    }

    function test_firstBuyReachesTheCreator() public {
        _fund(alice, 100e6);
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        vm.prank(alice);
        address token = launcher.launch(pass, sig, 100e6, 1);
        assertEq(IERC20(token).balanceOf(alice), 100e6 * 100);
        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(address(launcher)), 0);
        assertEq(IERC20(token).balanceOf(address(launcher)), 0);
    }

    function test_firstBuyRefundReachesTheCreator() public {
        adapter.set(2_500, false);
        _fund(alice, 100e6);
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        vm.prank(alice);
        address token = launcher.launch(pass, sig, 100e6, 1);
        assertEq(usdc.balanceOf(alice), 25e6);
        assertEq(IERC20(token).balanceOf(alice), 75e6 * 100);
    }

    function test_firstBuyEmits() public {
        _fund(alice, 100e6);
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        address token = address(new TestToken());
        adapter.force(token);
        vm.expectEmit(address(launcher));
        emit NeuriioLauncher.FirstBuy(token, alice, 100e6, 100e6 * 100);
        vm.prank(alice);
        launcher.launch(pass, sig, 100e6, 0);
    }

    function test_firstBuyBelowMinimumRevertsTheWholeLaunch() public {
        _fund(alice, 100e6);
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuriioLauncher.Slippage.selector, 100e6 * 100, 100e6 * 100 + 1));
        launcher.launch(pass, sig, 100e6, 100e6 * 100 + 1);
        assertEq(launcher.tokenOfXUser(ALICE_X), address(0));
        assertEq(usdc.balanceOf(alice), 100e6);
    }

    function test_adapterThatPaysNothingReverts() public {
        adapter.set(0, true);
        _fund(alice, 100e6);
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuriioLauncher.Slippage.selector, 0, 0));
        launcher.launch(pass, sig, 100e6, 0);
    }

    function test_firstBuyWithoutApprovalReverts() public {
        usdc.mint(alice, 100e6);
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        vm.prank(alice);
        vm.expectRevert();
        launcher.launch(pass, sig, 100e6, 1);
        assertEq(launcher.tokenOfXUser(ALICE_X), address(0));
    }

    function test_noFirstBuyTouchesNoUsdc() public {
        _fund(alice, 100e6);
        address token = _launch(alice, ALICE_X, "alice");
        assertEq(usdc.balanceOf(alice), 100e6);
        assertEq(IERC20(token).balanceOf(alice), 0);
    }

    function test_ftfFounderGetsTheFirstBuy() public {
        _fund(alice, 100e6);
        NeuriioLauncher.FtfPass memory pass = _ftfPass("Degen Den", "DEN");
        bytes memory sig = _signFtf(pass, signerKey);
        vm.prank(alice);
        address token = launcher.launchFtf(pass, sig, 100e6, 1);
        assertEq(IERC20(token).balanceOf(alice), 100e6 * 100);
        assertEq(IERC20(token).balanceOf(bob), 0);
    }

    function test_ftfFirstBuyBelowMinimumRevertsTheWholeLaunch() public {
        _fund(alice, 100e6);
        NeuriioLauncher.FtfPass memory pass = _ftfPass("Degen Den", "DEN");
        bytes memory sig = _signFtf(pass, signerKey);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuriioLauncher.Slippage.selector, 100e6 * 100, type(uint256).max));
        launcher.launchFtf(pass, sig, 100e6, type(uint256).max);
        assertEq(launcher.tokenOfFtfTicker(keccak256("DEN")), address(0));
    }

    // ------------------------------------------------------------------ owner and guardian

    function test_ownerOnlySetters() public {
        vm.startPrank(alice);
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
        vm.expectRevert(err);
        launcher.setAdapter(adapter);
        vm.expectRevert(err);
        launcher.setLaunchSigner(alice);
        vm.expectRevert(err);
        launcher.setGuardian(alice);
        vm.expectRevert(err);
        launcher.setReservedTickers(new string[](0), true);
        vm.expectRevert(err);
        launcher.unpause();
        vm.stopPrank();
    }

    function test_guardianPausesOnlyOwnerUnpauses() public {
        vm.prank(guardian);
        launcher.pause();
        _expectLaunchRevert(alice, ALICE_X, "alice", Pausable.EnforcedPause.selector);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        launcher.unpause();

        vm.prank(owner);
        launcher.unpause();
        _launch(alice, ALICE_X, "alice");
    }

    function test_strangerCantPause() public {
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.NotOwnerOrGuardian.selector);
        launcher.pause();
    }

    function test_noSignerStopsLaunches() public {
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        vm.prank(owner);
        launcher.setLaunchSigner(address(0));
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
        launcher.launch(pass, sig, 0, 0);
    }

    function testFuzz_passOnlyWorksForItsHolder(address caller) public {
        vm.assume(caller != alice);
        NeuriioLauncher.LaunchPass memory pass = _pass(alice, ALICE_X, "alice");
        bytes memory sig = _sign(pass, signerKey);
        vm.prank(caller);
        vm.expectRevert(NeuriioLauncher.NotPassHolder.selector);
        launcher.launch(pass, sig, 0, 0);
    }
}
