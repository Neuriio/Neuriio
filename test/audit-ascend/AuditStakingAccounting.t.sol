// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ILaunchedTokens, NeuriioTokenStaking} from "../../src/stake/NeuriioTokenStaking.sol";
import {AuditToken} from "./AscendAuditBase.sol";

contract LaunchedList is ILaunchedTokens {
    mapping(address => bool) public isLaunched;

    function set(address token) external {
        isLaunched[token] = true;
    }
}

/// A token that can be switched off, like a paused USDC or a broken launched token.
contract SwitchableToken is AuditToken(6) {
    bool public off;

    function setOff(bool off_) external {
        off = off_;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!off, "paused");
        super._update(from, to, value);
    }
}

/// Calls whatever it's told from inside a transfer.
contract HookToken is AuditToken(18) {
    address public target;
    bytes public data;

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (target != address(0) && from != address(0)) {
            (bool ok, bytes memory ret) = target.call(data);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}

/// Says it moved whatever it's asked to, and holds nothing.
contract LyingToken {
    uint256 internal _fake;

    function balanceOf(address) external view returns (uint256) {
        return _fake;
    }

    function transferFrom(address, address, uint256 amount) external returns (bool) {
        _fake += amount;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}

/// Cantina risk 5 (staking drip accounting): precision, rate rounding, settle-before-change ordering, no over-distribution,
/// and nothing locked when everyone leaves mid-drip. Each dollar figure is asserted, not just that it runs.
contract AuditStakingAccountingTest is Test {
    uint256 constant DRIP = 1 hours;
    uint256 constant USD = 1e6;
    uint256 constant ONE = 1e18;

    NeuriioTokenStaking staking;
    LaunchedList launched;
    SwitchableToken usdc;
    AuditToken token;
    AuditToken token2;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address payer = makeAddr("payer");

    function setUp() public {
        vm.warp(1_760_000_000);
        usdc = new SwitchableToken();
        token = new AuditToken(18);
        token2 = new AuditToken(18);
        launched = new LaunchedList();
        launched.set(address(token));
        launched.set(address(token2));
        staking = new NeuriioTokenStaking(usdc, launched);
        address[3] memory people = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            for (uint256 t; t < 2; ++t) {
                AuditToken tk = t == 0 ? token : token2;
                tk.mint(people[i], 1e36);
                vm.prank(people[i]);
                tk.approve(address(staking), type(uint256).max);
            }
        }
        usdc.mint(payer, 1e30);
        vm.prank(payer);
        usdc.approve(address(staking), type(uint256).max);
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        staking.stake(address(token), amount);
    }

    function _unstake(address who, uint256 amount) internal {
        vm.prank(who);
        staking.unstake(address(token), amount);
    }

    function _reward(uint256 amount) internal {
        vm.prank(payer);
        staking.notifyReward(address(token), amount);
    }

    function _earned(address who) internal view returns (uint256) {
        return staking.earned(who, address(token));
    }

    function _claim(address who) internal returns (uint256) {
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        vm.prank(who);
        return staking.claim(tokens, who);
    }

    // ------------------------------------------------------------------ exact shares

    function test_joinMidDripSharesOnlyWhatDripsAfter() public {
        _stake(alice, 100 * ONE);
        _reward(3_600 * USD);
        skip(DRIP / 2); // alice alone: $1,800
        _stake(bob, 100 * ONE); // the other $1,800, half each
        skip(DRIP / 2);
        assertApproxEqAbs(_earned(alice), 2_700 * USD, 2);
        assertApproxEqAbs(_earned(bob), 900 * USD, 2);
    }

    function test_settlesBeforeEveryChangeOfStake() public {
        _stake(alice, 100 * ONE);
        _reward(3_600 * USD);
        skip(900); // $900 at 100
        _stake(alice, 300 * ONE); // now 400 of 500 once bob joins
        _stake(bob, 100 * ONE);
        skip(900); // $900: alice 4/5
        _unstake(alice, 300 * ONE); // now 100 of 200
        skip(1800); // $1,800: half each
        assertApproxEqAbs(_earned(alice), 900 * USD + 720 * USD + 900 * USD, 4);
        assertApproxEqAbs(_earned(bob), 180 * USD + 900 * USD, 4);
    }

    function test_lateStakeOverAFinishedDripEarnsNothing() public {
        _stake(alice, ONE);
        _reward(1_000 * USD);
        skip(DRIP * 5);
        _stake(bob, ONE * 1_000_000);
        skip(DRIP * 5);
        assertEq(_earned(bob), 0);
        assertApproxEqAbs(_earned(alice), 1_000 * USD, 1);
    }

    function test_stakeAndUnstakeInOneBlockEarnsNothing() public {
        _stake(alice, ONE);
        _reward(1_000 * USD);
        skip(600);
        vm.startPrank(bob);
        staking.stake(address(token), ONE * 1e9);
        staking.unstake(address(token), ONE * 1e9);
        vm.stopPrank();
        assertEq(_earned(bob), 0);
        skip(DRIP);
        assertApproxEqAbs(_earned(alice), 1_000 * USD, 1);
    }

    // ------------------------------------------------------------------ rounding and extremes

    /// Never pays more than came in, and loses next to nothing, at any sizes.
    function testFuzz_rewardFullyPaidWithinDust(uint256 rawAmount, uint256 rawA, uint256 rawB, uint256 rawGap) public {
        uint256 amount = bound(rawAmount, 1, 1e18); // up to $1T
        uint256 a = bound(rawA, 1, 1e33);
        uint256 b = bound(rawB, 1, 1e33);
        uint256 gap = bound(rawGap, 0, DRIP);
        _stake(alice, a);
        _reward(amount);
        skip(gap);
        _stake(bob, b);
        skip(DRIP * 2);
        uint256 paid = _earned(alice) + _earned(bob);
        assertLe(paid, amount);
        assertLe(amount - paid, 3);
    }

    function test_oneWeiStakedThenAWhale() public {
        _stake(alice, 1);
        _reward(1e15); // $1B on a single wei
        skip(DRIP / 2);
        _stake(bob, 1e33);
        skip(DRIP);
        uint256 paid = _earned(alice) + _earned(bob);
        assertLe(paid, 1e15);
        assertGe(paid, 1e15 - 3);
        assertApproxEqAbs(_earned(alice), 1e15 / 2, 1e9); // about half, before the whale came in
    }

    function test_oneUnitRewardOverAHugeStakeIsntLost() public {
        _stake(alice, 1e33);
        _reward(1);
        skip(DRIP);
        assertLe(_earned(alice), 1);
    }

    /// FINDING I-01: rounding costs dust, even with someone updating the pool every minute: $10 over 100M staked loses under 60
    /// base units ($0.00006), which stays in the contract with no owner to sweep it.
    function test_I01_realUpdatesEveryMinuteCostOnlyDust() public {
        _stake(alice, 100_000_000 * ONE);
        _reward(10 * USD);
        for (uint256 i; i < 60; ++i) {
            skip(60);
            _stake(bob, 1);
        }
        assertGe(_earned(alice) + _earned(bob), 10 * USD - 60);
        assertLe(_earned(alice) + _earned(bob), 10 * USD);
    }

    function test_dustNeverBlocksAClaimOrAnExit() public {
        _stake(alice, 1);
        _stake(bob, 1e33);
        _reward(1_000);
        skip(DRIP);
        assertEq(_earned(alice), 0); // rounds down, for the smallest stake
        _unstake(alice, 1);
        assertGt(_claim(bob), 0);
        _unstake(bob, 1e33);
    }

    // ------------------------------------------------------------------ everyone leaving, nobody there

    function test_everyoneLeavesAndComesBackRepeatedly() public {
        _stake(alice, ONE);
        _reward(3_600 * USD);
        uint256 paidTotal;
        for (uint256 i; i < 6; ++i) {
            skip(600); // $600 to whoever is in
            _unstake(alice, ONE);
            paidTotal = _earned(alice);
            skip(7 days); // on hold: no time counts
            assertApproxEqAbs(staking.dripping(address(token)) + paidTotal, 3_600 * USD, 12);
            _stake(alice, ONE);
        }
        skip(DRIP);
        assertApproxEqAbs(_claim(alice), 3_600 * USD, 12);
        assertEq(staking.dripping(address(token)), 0);
    }

    function test_newRewardWhileOnHoldKeepsTheHeldPart() public {
        _reward(1_000 * USD);
        skip(30 days);
        _reward(500 * USD);
        assertApproxEqAbs(staking.dripping(address(token)), 1_500 * USD, 1);
        _stake(alice, ONE);
        skip(DRIP);
        assertApproxEqAbs(_earned(alice), 1_500 * USD, 2);
    }

    /// FINDING L-01 (the first-staker rule): held money all goes to whoever stakes first, even 1 wei. The fee router sends a
    /// token with no stakers to treasury, so the contract only holds money if everyone leaves between its plan and its send.
    function test_L01_firstStakerTakesWhatsHeld() public {
        _reward(1_000 * USD);
        skip(30 days);
        _stake(bob, 1);
        skip(DRIP);
        assertApproxEqAbs(_earned(bob), 1_000 * USD, 1);
    }

    // ------------------------------------------------------------------ griefing

    /// FINDING L-02: anyone can call notifyReward with 1 base unit, and each call spreads what's left over a fresh hour. Done
    /// non-stop this slows payment down, to about 63% after the first hour instead of 100%. Nothing is lost, it costs the
    /// griefer gas plus the dust they add, and they gain nothing; the moment they stop, the rest finishes within the hour.
    function test_L02_dustRewardsSlowADripButLoseNothing() public {
        _stake(alice, ONE);
        _reward(3_600 * USD);
        for (uint256 i; i < 60; ++i) {
            skip(60);
            _reward(1);
        }
        uint256 afterHour = _earned(alice);
        assertGt(afterHour, 3_600 * USD * 60 / 100);
        assertLt(afterHour, 3_600 * USD * 66 / 100);
        skip(DRIP);
        assertApproxEqAbs(_earned(alice), 3_600 * USD + 60, 3);
    }

    // ------------------------------------------------------------------ things outside it failing or lying

    function test_usdcPausedStillLetsPeopleLeave() public {
        _stake(alice, ONE);
        _reward(1_000 * USD);
        skip(DRIP);
        usdc.setOff(true);
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        vm.prank(alice);
        vm.expectRevert("paused");
        staking.claim(tokens, alice);
        _unstake(alice, ONE); // the stake comes back regardless
        assertEq(token.balanceOf(address(staking)), 0);
        usdc.setOff(false);
        assertApproxEqAbs(_claim(alice), 1_000 * USD, 1); // and the rewards wait
    }

    function test_aBrokenTokenOnlyBreaksItsOwnPool() public {
        SwitchableToken broken = new SwitchableToken();
        launched.set(address(broken));
        broken.mint(alice, ONE);
        vm.startPrank(alice);
        broken.approve(address(staking), ONE);
        staking.stake(address(broken), ONE);
        staking.stake(address(token), ONE);
        vm.stopPrank();
        vm.startPrank(payer);
        staking.notifyReward(address(broken), 100 * USD);
        staking.notifyReward(address(token), 100 * USD);
        vm.stopPrank();
        skip(DRIP);
        broken.setOff(true);
        vm.prank(alice);
        vm.expectRevert("paused");
        staking.unstake(address(broken), ONE);
        // rewards don't touch the staked token, so even its own pool still pays
        address[] memory both = new address[](2);
        both[0] = address(broken);
        both[1] = address(token);
        vm.prank(alice);
        assertApproxEqAbs(staking.claim(both, alice), 200 * USD, 2);
        _unstake(alice, ONE);
    }

    /// A lying token, however it got launched, only fools its own pool: other pools' tokens and USDC stay out of reach.
    function test_aLyingTokenCantReachOtherPools() public {
        _stake(alice, ONE);
        _reward(1_000 * USD);
        LyingToken liar = new LyingToken();
        launched.set(address(liar));
        vm.startPrank(bob);
        staking.stake(address(liar), 1e30);
        staking.unstake(address(liar), 1e30);
        address[] memory list = new address[](1);
        list[0] = address(liar);
        vm.expectRevert(NeuriioTokenStaking.NothingToClaim.selector);
        staking.claim(list, bob);
        vm.stopPrank();
        assertEq(usdc.balanceOf(bob), 0);
        assertEq(token.balanceOf(address(staking)), ONE);
        assertEq(usdc.balanceOf(address(staking)), 1_000 * USD);
    }

    function test_noReentryFromAStakedToken() public {
        HookToken hook = new HookToken();
        launched.set(address(hook));
        hook.mint(alice, 10 * ONE);
        vm.startPrank(alice);
        hook.approve(address(staking), type(uint256).max);
        staking.stake(address(hook), ONE);
        vm.stopPrank();
        address[] memory list = new address[](1);
        list[0] = address(hook);
        bytes[4] memory calls = [
            abi.encodeCall(staking.unstake, (address(hook), 1)),
            abi.encodeCall(staking.stake, (address(hook), 1)),
            abi.encodeCall(staking.claim, (list, alice)),
            abi.encodeCall(staking.notifyReward, (address(hook), 1))
        ];
        for (uint256 i; i < 4; ++i) {
            hook.arm(address(staking), calls[i]);
            vm.prank(alice);
            vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
            staking.stake(address(hook), ONE);
            vm.prank(alice);
            vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
            staking.unstake(address(hook), ONE);
        }
    }

    /// FINDING I-03: USDC or tokens sent straight to the contract aren't anyone's, and there's no owner to rescue them.
    function test_I03_donationsChangeNothingAndStayThere() public {
        _stake(alice, ONE);
        usdc.mint(address(staking), 77 * USD);
        token.mint(address(staking), 77 * ONE);
        _reward(1_000 * USD);
        skip(DRIP);
        assertApproxEqAbs(_claim(alice), 1_000 * USD, 1);
        _unstake(alice, ONE);
        assertApproxEqAbs(usdc.balanceOf(address(staking)), 77 * USD, 1);
        assertEq(token.balanceOf(address(staking)), 77 * ONE);
    }

    function test_positionsArePersonal() public {
        _stake(alice, ONE);
        _reward(1_000 * USD);
        skip(DRIP);
        address[] memory list = new address[](1);
        list[0] = address(token);
        vm.prank(bob);
        vm.expectRevert(NeuriioTokenStaking.NothingToClaim.selector);
        staking.claim(list, bob);
        vm.prank(bob);
        vm.expectRevert(NeuriioTokenStaking.InsufficientStake.selector);
        staking.unstake(address(token), 1);
    }

    function test_unlaunchedTokenCantStakeOrBeFunded() public {
        AuditToken other = new AuditToken(18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuriioTokenStaking.NotStakeable.selector, address(other)));
        staking.stake(address(other), 1);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(NeuriioTokenStaking.NotStakeable.selector, address(other)));
        staking.notifyReward(address(other), 1);
    }
}
