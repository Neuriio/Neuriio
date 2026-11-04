// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ILaunchedTokens, NeuriioTokenStaking} from "../../src/stake/NeuriioTokenStaking.sol";
import {NeuriioLauncher} from "../../src/launch/NeuriioLauncher.sol";
import {AuditAdapter, AuditToken} from "./AscendAuditBase.sol";

/// Random stakes, unstakes, claims, rewards and time jumps across 2 pools and 3 people, with the books kept independently here.
contract StakingHandler is Test {
    NeuriioTokenStaking public staking;
    AuditToken public usdc;
    AuditToken[2] public tokens;
    address[3] public people;
    mapping(address token => mapping(address who => uint256)) public staked;
    mapping(address token => uint256) public totalIn;
    mapping(address token => mapping(address who => uint256)) public lastEarned;
    uint256 public notified;
    uint256 public claimed;
    uint256 public moves;
    bool public earnedFell;
    bytes public unexpected; // revert data of the first call that should never have failed
    uint256 public stakes;
    uint256 public rewards;
    uint256 public claims;
    uint256 public unstakes;

    constructor(NeuriioTokenStaking staking_, AuditToken usdc_, AuditToken a, AuditToken b) {
        staking = staking_;
        usdc = usdc_;
        tokens = [a, b];
        people = [makeAddr("p0"), makeAddr("p1"), makeAddr("p2")];
        for (uint256 i; i < 3; ++i) {
            for (uint256 t; t < 2; ++t) {
                tokens[t].mint(people[i], 1e40);
                vm.prank(people[i]);
                tokens[t].approve(address(staking), type(uint256).max);
            }
        }
        usdc.mint(address(this), 1e40);
        usdc.approve(address(staking), type(uint256).max);
    }

    function _note(bytes memory err) internal {
        if (unexpected.length == 0) unexpected = err.length == 0 ? bytes("empty revert") : err;
    }

    function _checkMonotonic() internal {
        for (uint256 t; t < 2; ++t) {
            for (uint256 i; i < 3; ++i) {
                uint256 e = staking.earned(people[i], address(tokens[t]));
                if (e < lastEarned[address(tokens[t])][people[i]]) earnedFell = true;
                lastEarned[address(tokens[t])][people[i]] = e;
            }
        }
    }

    function stake(uint256 who, uint256 t, uint256 amount) external {
        address a = people[who % 3];
        AuditToken tk = tokens[t % 2];
        // from dust to whale, on a log scale
        amount = (bound(amount, 1, 1e12) * 10 ** bound(amount >> 128, 0, 21));
        _checkMonotonic();
        vm.prank(a);
        try staking.stake(address(tk), amount) {
            staked[address(tk)][a] += amount;
            totalIn[address(tk)] += amount;
            stakes++;
            moves++;
        } catch (bytes memory err) {
            _note(err);
        }
        _checkMonotonic();
    }

    function unstake(uint256 who, uint256 t, uint256 amount) external {
        address a = people[who % 3];
        AuditToken tk = tokens[t % 2];
        uint256 have = staked[address(tk)][a];
        if (have == 0) return;
        amount = bound(amount, 1, have);
        _checkMonotonic();
        vm.prank(a);
        try staking.unstake(address(tk), amount) {
            staked[address(tk)][a] -= amount;
            totalIn[address(tk)] -= amount;
            unstakes++;
            moves++;
        } catch (bytes memory err) {
            _note(err);
        }
        _checkMonotonic();
    }

    function claim(uint256 who, uint256 t) external {
        address a = people[who % 3];
        address tk = address(tokens[t % 2]);
        uint256 owed = staking.earned(a, tk);
        address[] memory list = new address[](1);
        list[0] = tk;
        vm.prank(a);
        if (owed == 0) {
            vm.expectRevert(NeuriioTokenStaking.NothingToClaim.selector);
            staking.claim(list, a);
            return;
        }
        try staking.claim(list, a) returns (uint256 got) {
            if (got != owed) _note("claim paid a different amount than earned()");
            claimed += got;
            lastEarned[tk][a] = 0;
            claims++;
            moves++;
        } catch (bytes memory err) {
            _note(err);
        }
    }

    function reward(uint256 t, uint256 amount) external {
        amount = bound(amount, 1, 1e12) * 10 ** bound(amount >> 128, 0, 6);
        _checkMonotonic();
        try staking.notifyReward(address(tokens[t % 2]), amount) {
            notified += amount;
            rewards++;
            moves++;
        } catch (bytes memory err) {
            _note(err);
        }
        _checkMonotonic();
    }

    function wait(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
        _checkMonotonic();
    }
}

contract StakingLaunched is ILaunchedTokens {
    function isLaunched(address) external pure returns (bool) {
        return true;
    }
}

contract AuditStakingInvariants is Test {
    StakingHandler handler;
    NeuriioTokenStaking staking;
    AuditToken usdc;
    AuditToken a;
    AuditToken b;

    function setUp() public {
        vm.warp(1_760_000_000);
        usdc = new AuditToken(6);
        a = new AuditToken(18);
        b = new AuditToken(18);
        staking = new NeuriioTokenStaking(usdc, new StakingLaunched());
        handler = new StakingHandler(staking, usdc, a, b);
        bytes4[] memory sel = new bytes4[](5);
        sel[0] = handler.stake.selector;
        sel[1] = handler.unstake.selector;
        sel[2] = handler.claim.selector;
        sel[3] = handler.reward.selector;
        sel[4] = handler.wait.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    function _sumEarned() internal view returns (uint256 sum) {
        for (uint256 t; t < 2; ++t) {
            for (uint256 i; i < 3; ++i) {
                sum += staking.earned(handler.people(i), address(handler.tokens(t)));
            }
        }
    }

    /// Every staked token is there, and every position matches the independent books.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    function invariant_stakesAddUp() public view {
        for (uint256 t; t < 2; ++t) {
            AuditToken tk = handler.tokens(t);
            assertEq(tk.balanceOf(address(staking)), handler.totalIn(address(tk)));
            assertEq(staking.totalStaked(address(tk)), handler.totalIn(address(tk)));
            for (uint256 i; i < 3; ++i) {
                address who = handler.people(i);
                assertEq(staking.stakedOf(who, address(tk)), handler.staked(address(tk), who));
            }
        }
    }

    /// The contract can always pay everything it owes, and what it holds is what came in less what went out.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    function invariant_alwaysSolvent() public view {
        uint256 held = usdc.balanceOf(address(staking));
        assertEq(held, handler.notified() - handler.claimed());
        uint256 owed = _sumEarned() + staking.dripping(address(a)) + staking.dripping(address(b));
        assertLe(owed, held, "owes more than it holds");
    }

    /// Nothing but rounding dust ever goes missing: everything is either claimable or still dripping.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    function invariant_onlyDustGoesMissing() public view {
        uint256 held = usdc.balanceOf(address(staking));
        uint256 owed = _sumEarned() + staking.dripping(address(a)) + staking.dripping(address(b));
        assertLe(held - owed, 8 + handler.moves() * 3, "more than dust is missing");
    }

    /// Someone's earnings only ever go up until they claim, and no call that should work ever failed.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    function invariant_earningsNeverFallAndNothingUnexpectedlyFails() public view {
        assertFalse(handler.earnedFell());
        assertEq(handler.unexpected(), bytes(""));
    }

    /// The campaign really did all of it.
    function afterInvariant() public view {
        assertGt(handler.stakes(), 0);
        assertGt(handler.rewards(), 0);
    }
}

/// Random launches, FTFs, first buys and failures, with the launcher's records checked after each.
contract LauncherHandler is Test {
    NeuriioLauncher public launcher;
    AuditAdapter public adapter;
    AuditToken public usdc;
    uint256 internal signerPk;
    uint64 internal nextId = 1;
    uint256 internal nextWallet = 0x100000;
    uint256 internal nextHandle = 1;
    address[] public launched;
    mapping(address token => uint64) public xIdOf;
    mapping(address token => address) public creatorOf;
    mapping(address token => bytes32) public handleKeyOf;
    mapping(address token => bytes32) public tickerKeyOf;
    uint256 public successes;
    uint256 public failures;
    bytes public unexpected;

    constructor(NeuriioLauncher launcher_, AuditAdapter adapter_, AuditToken usdc_, uint256 pk) {
        launcher = launcher_;
        adapter = adapter_;
        usdc = usdc_;
        signerPk = pk;
    }

    function launchedLength() external view returns (uint256) {
        return launched.length;
    }

    function _wallet() internal returns (address w) {
        w = address(uint160(nextWallet++));
        usdc.mint(w, 1e18);
        vm.prank(w);
        usdc.approve(address(launcher), type(uint256).max);
    }

    function _mode(uint256 seed) internal returns (bool fails) {
        AuditAdapter.Mode m = AuditAdapter.Mode(seed % 6);
        adapter.setMode(m);
        return m != AuditAdapter.Mode.Normal && m != AuditAdapter.Mode.RefundHalf;
    }

    function personal(uint256 seed, uint256 buy) external {
        address who = _wallet();
        string memory handle = string.concat("h", vm.toString(nextHandle++));
        buy = bound(buy, 0, 1e15);
        bool fails = _mode(seed);
        bool noBuyPath = buy == 0;
        NeuriioLauncher.LaunchPass memory p =
            NeuriioLauncher.LaunchPass(who, nextId++, handle, uint8(seed % 6), keccak256("p"), "", block.timestamp + 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, launcher.hashLaunchPass(p));
        vm.prank(who);
        try launcher.launch(p, abi.encodePacked(r, s, v), buy, 0) returns (address token) {
            if (fails && !(noBuyPath && adapter.mode() != AuditAdapter.Mode.RevertLaunch)) {
                _note("a bad launch got through");
            }
            launched.push(token);
            xIdOf[token] = p.xUserId;
            creatorOf[token] = who;
            handleKeyOf[token] = keccak256(bytes(handle));
            successes++;
        } catch {
            if (!fails) _note("a good launch failed");
            failures++;
        }
    }

    function ftf(uint256 seed, uint256 buy) external {
        address founder = _wallet();
        string memory ticker = string.concat("T", vm.toString(nextHandle++));
        buy = bound(buy, 0, 1e15);
        bool fails = _mode(seed);
        bool noBuyPath = buy == 0;
        uint64 base = nextId;
        nextId += 4;
        NeuriioLauncher.FtfPass memory p = NeuriioLauncher.FtfPass(
            founder,
            "Some Den",
            ticker,
            [base, base + 1, base + 2, base + 3],
            [founder, address(uint160(nextWallet++)), address(uint160(nextWallet++)), address(uint160(nextWallet++))],
            keccak256("p"),
            "",
            block.timestamp + 1
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, launcher.hashFtfPass(p));
        vm.prank(founder);
        try launcher.launchFtf(p, abi.encodePacked(r, s, v), buy, 0) returns (address token) {
            if (fails && !(noBuyPath && adapter.mode() != AuditAdapter.Mode.RevertLaunch)) {
                _note("a bad FTF got through");
            }
            launched.push(token);
            creatorOf[token] = founder;
            tickerKeyOf[token] = keccak256(bytes(ticker));
            successes++;
        } catch {
            if (!fails) _note("a good FTF failed");
            failures++;
        }
    }

    function _note(bytes memory err) internal {
        if (unexpected.length == 0) unexpected = err;
    }
}

contract AuditLauncherInvariants is Test {
    LauncherHandler handler;
    NeuriioLauncher launcher;
    AuditAdapter adapter;
    AuditToken usdc;

    function setUp() public {
        vm.warp(1_760_000_000);
        uint256 pk = 0xA11CE;
        usdc = new AuditToken(6);
        launcher = new NeuriioLauncher(address(this), usdc, vm.addr(pk), address(this));
        adapter = new AuditAdapter(usdc);
        launcher.setAdapter(adapter);
        handler = new LauncherHandler(launcher, adapter, usdc, pk);
        bytes4[] memory sel = new bytes4[](2);
        sel[0] = handler.personal.selector;
        sel[1] = handler.ftf.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// The launcher and adapter never end up holding anyone's USDC or tokens.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 40
    function invariant_holdsNothing() public view {
        assertEq(usdc.balanceOf(address(launcher)), 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        for (uint256 i; i < handler.launchedLength(); ++i) {
            assertEq(AuditToken(handler.launched(i)).balanceOf(address(launcher)), 0);
        }
    }

    /// Every launch that succeeded is fully recorded, every one that failed left nothing, and no bad launch got through.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 40
    function invariant_recordsMatch() public view {
        assertEq(handler.unexpected(), bytes(""));
        assertEq(launcher.allTokensLength(), handler.launchedLength());
        assertEq(handler.successes(), handler.launchedLength());
        for (uint256 i; i < handler.launchedLength(); ++i) {
            address token = handler.launched(i);
            assertEq(launcher.allTokens(i), token);
            assertTrue(launcher.isLaunched(token));
            assertEq(launcher.creatorOf(token), handler.creatorOf(token));
            if (handler.tickerKeyOf(token) != bytes32(0)) {
                assertTrue(launcher.isFtf(token));
                assertEq(launcher.tokenOfFtfTicker(handler.tickerKeyOf(token)), token);
                assertEq(launcher.creatorsOf(token).length, 4);
            } else {
                assertFalse(launcher.isFtf(token));
                assertEq(launcher.tokenOfXUser(handler.xIdOf(token)), token);
                assertEq(launcher.tokenOfCreator(handler.creatorOf(token)), token);
                assertEq(launcher.tokenOfHandle(handler.handleKeyOf(token)), token);
                assertEq(launcher.creatorsOf(token).length, 1);
            }
        }
    }
}
