// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {NeuriioPartnerStaking} from "../src/stake/NeuriioPartnerStaking.sol";

contract TestToken is ERC20 {
    uint8 internal immutable _decimals;

    constructor(uint8 decimals_) ERC20("Test", "TEST") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Burns 10% of every transfer.
contract FeeToken is TestToken(18) {
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 10;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// Calls back into staking when it moves this token.
contract ReentrantToken is TestToken(18) {
    NeuriioPartnerStaking public target;

    function arm(NeuriioPartnerStaking t) external {
        target = t;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(target) != address(0) && from != address(0)) target.unstake(address(this), 1);
    }
}

contract NeuriioPartnerStakingTest is Test {
    NeuriioPartnerStaking internal staking;
    address internal owner = makeAddr("owner"); // the timelock
    TestToken internal usdc;
    TestToken internal token;
    TestToken internal token2;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal payer = makeAddr("payer");
    uint256 internal constant STAKE = 1_000e18;
    uint256 internal constant REWARD = 3_600e6; // $3,600: exactly $1 a second over the drip
    uint256 internal constant DRIP = 1 hours;

    function setUp() public {
        vm.warp(1_000_000);
        usdc = new TestToken(6);
        token = new TestToken(18);
        token2 = new TestToken(18);
        staking = new NeuriioPartnerStaking(usdc, owner);
        vm.startPrank(owner);
        staking.setListed(address(token), true);
        staking.setListed(address(token2), true);
        vm.stopPrank();

        address[3] memory people = [alice, bob, payer];
        for (uint256 i; i < people.length; ++i) {
            token.mint(people[i], 1_000_000e18);
            token2.mint(people[i], 1_000_000e18);
            vm.startPrank(people[i]);
            token.approve(address(staking), type(uint256).max);
            token2.approve(address(staking), type(uint256).max);
            vm.stopPrank();
        }
        usdc.mint(payer, 1e15);
        vm.prank(payer);
        usdc.approve(address(staking), type(uint256).max);
    }

    function _stake(address who, IERC20 t, uint256 amount) internal {
        vm.prank(who);
        staking.stake(address(t), amount);
    }

    function _reward(IERC20 t, uint256 amount) internal {
        vm.prank(payer);
        staking.notifyReward(address(t), amount);
    }

    function _claim(address who, IERC20 t) internal returns (uint256) {
        address[] memory tokens = new address[](1);
        tokens[0] = address(t);
        vm.prank(who);
        return staking.claim(tokens, who);
    }

    // ------------------------------------------------------------------ who can stake

    function test_onlyListedTokensStake() public {
        TestToken other = new TestToken(18);
        assertFalse(staking.isStakeable(address(other)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NeuriioPartnerStaking.NotStakeable.selector, address(other)));
        staking.stake(address(other), 1);
    }

    function test_rewardsOnlyForListedTokens() public {
        TestToken other = new TestToken(18);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(NeuriioPartnerStaking.NotStakeable.selector, address(other)));
        staking.notifyReward(address(other), 1);
    }

    // ------------------------------------------------------------------ stake and unstake

    function test_stakeAndUnstake() public {
        uint256 start = token.balanceOf(alice);
        _stake(alice, token, STAKE);
        assertEq(staking.stakedOf(alice, address(token)), STAKE);
        assertEq(staking.totalStaked(address(token)), STAKE);
        assertEq(token.balanceOf(alice), start - STAKE);

        vm.prank(alice);
        staking.unstake(address(token), STAKE / 4);
        assertEq(staking.stakedOf(alice, address(token)), STAKE * 3 / 4);
        assertEq(token.balanceOf(alice), start - STAKE * 3 / 4);
    }

    function test_zeroAmountsRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(NeuriioPartnerStaking.ZeroAmount.selector);
        staking.stake(address(token), 0);
        vm.expectRevert(NeuriioPartnerStaking.ZeroAmount.selector);
        staking.unstake(address(token), 0);
        vm.stopPrank();
    }

    function test_cantUnstakeMoreThanStaked() public {
        _stake(alice, token, STAKE);
        vm.prank(alice);
        vm.expectRevert(NeuriioPartnerStaking.InsufficientStake.selector);
        staking.unstake(address(token), STAKE + 1);
        vm.prank(bob);
        vm.expectRevert(NeuriioPartnerStaking.InsufficientStake.selector);
        staking.unstake(address(token), 1);
    }

    function test_feeOnTransferTokenCountsWhatArrived() public {
        FeeToken fee = new FeeToken();
        vm.prank(owner);
        staking.setListed(address(fee), true);
        fee.mint(alice, STAKE);
        vm.startPrank(alice);
        fee.approve(address(staking), STAKE);
        staking.stake(address(fee), STAKE);
        vm.stopPrank();
        assertEq(staking.stakedOf(alice, address(fee)), STAKE * 9 / 10);
    }

    function test_tokenCantReenter() public {
        ReentrantToken bad = new ReentrantToken();
        vm.prank(owner);
        staking.setListed(address(bad), true);
        bad.mint(alice, STAKE);
        vm.prank(alice);
        bad.approve(address(staking), STAKE);
        bad.arm(staking);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        staking.stake(address(bad), STAKE);
    }

    function test_stakedTokensCantBeTakenByAnyoneElse() public {
        _stake(alice, token, STAKE);
        vm.prank(bob);
        vm.expectRevert(NeuriioPartnerStaking.InsufficientStake.selector);
        staking.unstake(address(token), STAKE);
        assertEq(token.balanceOf(address(staking)), STAKE);
    }

    // ------------------------------------------------------------------ the drip

    function test_rewardDripsEvenlyOverAnHour() public {
        _stake(alice, token, STAKE);
        _reward(token, REWARD);
        assertEq(staking.earned(alice, address(token)), 0);
        assertEq(staking.dripping(address(token)), REWARD);

        skip(DRIP / 2);
        assertApproxEqAbs(staking.earned(alice, address(token)), REWARD / 2, 1);
        assertApproxEqAbs(staking.dripping(address(token)), REWARD / 2, 1);

        skip(DRIP);
        assertApproxEqAbs(staking.earned(alice, address(token)), REWARD, 1);
        assertEq(staking.dripping(address(token)), 0);
    }

    function test_stakersShareByAmount() public {
        _stake(alice, token, STAKE * 3);
        _stake(bob, token, STAKE);
        _reward(token, REWARD);
        skip(DRIP);
        assertApproxEqAbs(_claim(alice, token), REWARD * 3 / 4, 2);
        assertApproxEqAbs(_claim(bob, token), REWARD / 4, 2);
    }

    function test_cantStakeAtTheLastMomentAndCatchAFee() public {
        _stake(alice, token, STAKE);
        _reward(token, REWARD);
        skip(DRIP - 1);
        _stake(bob, token, STAKE * 1000);
        skip(1);
        assertLt(staking.earned(bob, address(token)), 1e6); // under $1 of $3,600
    }

    function test_sniperEarnsNothingByStakingAndLeavingAtOnce() public {
        _stake(alice, token, STAKE);
        _reward(token, REWARD);
        vm.startPrank(bob);
        staking.stake(address(token), STAKE * 1000);
        staking.unstake(address(token), STAKE * 1000);
        vm.stopPrank();
        assertEq(staking.earned(bob, address(token)), 0);
    }

    function test_rewardWithNobodyStakedWaitsForTheNextStaker() public {
        _reward(token, REWARD);
        skip(10 hours);
        assertEq(staking.dripping(address(token)), REWARD);
        _stake(alice, token, STAKE);
        skip(DRIP);
        assertApproxEqAbs(_claim(alice, token), REWARD, 2);
    }

    function test_everyoneLeavingMidDripPausesIt() public {
        _stake(alice, token, STAKE);
        _reward(token, REWARD);
        skip(DRIP / 2);
        vm.prank(alice);
        staking.unstake(address(token), STAKE);
        uint256 aliceEarned = staking.earned(alice, address(token));
        skip(5 hours);
        assertEq(staking.earned(alice, address(token)), aliceEarned);

        _stake(bob, token, STAKE);
        skip(DRIP);
        assertApproxEqAbs(aliceEarned + staking.earned(bob, address(token)), REWARD, 3);
    }

    function test_newRewardRollsInWhatsStillDripping() public {
        _stake(alice, token, STAKE);
        _reward(token, REWARD);
        skip(DRIP / 2);
        _reward(token, REWARD);
        assertApproxEqAbs(staking.dripping(address(token)), REWARD * 3 / 2, 2);
        skip(DRIP);
        assertApproxEqAbs(staking.earned(alice, address(token)), REWARD * 2, 3);
    }

    function test_zeroRewardDoesNothing() public {
        _reward(token, 0);
        assertEq(staking.dripping(address(token)), 0);
    }

    function test_poolsAreSeparate() public {
        _stake(alice, token, STAKE);
        _stake(bob, token2, STAKE);
        _reward(token, REWARD);
        skip(DRIP);
        assertApproxEqAbs(staking.earned(alice, address(token)), REWARD, 1);
        assertEq(staking.earned(bob, address(token2)), 0);
    }

    // ------------------------------------------------------------------ claiming

    function test_claimPaysUsdcAndResets() public {
        _stake(alice, token, STAKE);
        _reward(token, REWARD);
        skip(DRIP);
        uint256 got = _claim(alice, token);
        assertApproxEqAbs(got, REWARD, 1);
        assertEq(usdc.balanceOf(alice), got);
        assertEq(staking.earned(alice, address(token)), 0);
        vm.prank(alice);
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        vm.expectRevert(NeuriioPartnerStaking.NothingToClaim.selector);
        staking.claim(tokens, alice);
    }

    function test_claimKeepsTheStake() public {
        _stake(alice, token, STAKE);
        _reward(token, REWARD);
        skip(DRIP);
        _claim(alice, token);
        assertEq(staking.stakedOf(alice, address(token)), STAKE);
    }

    function test_claimManyPoolsToAnotherWallet() public {
        _stake(alice, token, STAKE);
        _stake(alice, token2, STAKE);
        _reward(token, REWARD);
        _reward(token2, REWARD);
        skip(DRIP);
        address[] memory tokens = new address[](2);
        tokens[0] = address(token);
        tokens[1] = address(token2);
        vm.prank(alice);
        uint256 got = staking.claim(tokens, bob);
        assertApproxEqAbs(got, REWARD * 2, 2);
        assertEq(usdc.balanceOf(bob), got);
        assertEq(usdc.balanceOf(alice), 0);
    }

    function test_listingAPoolTwiceDoesntPayTwice() public {
        _stake(alice, token, STAKE);
        _reward(token, REWARD);
        skip(DRIP);
        address[] memory tokens = new address[](2);
        tokens[0] = address(token);
        tokens[1] = address(token);
        vm.prank(alice);
        assertApproxEqAbs(staking.claim(tokens, alice), REWARD, 1);
    }

    function test_unstakingKeepsEarnedRewards() public {
        _stake(alice, token, STAKE);
        _reward(token, REWARD);
        skip(DRIP);
        vm.prank(alice);
        staking.unstake(address(token), STAKE);
        assertApproxEqAbs(_claim(alice, token), REWARD, 1);
    }

    function test_nothingToClaimReverts() public {
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        vm.prank(alice);
        vm.expectRevert(NeuriioPartnerStaking.NothingToClaim.selector);
        staking.claim(tokens, alice);
    }

    // ------------------------------------------------------------------ the whole fee route

    /// Ascend's fees land in one wallet as plain USDC. The bot keeps 60% there (KNTQ buyback + treasury, handled by hand) and
    /// pays 40% into each token's pool, by that token's share of the fees.
    function test_feeRouteFromOneWalletToEachTokensStakers() public {
        address feeWallet = makeAddr("feeWallet");
        uint256 received = 1_000e6;
        usdc.mint(feeWallet, received);
        (uint256 fromToken, uint256 fromToken2) = (received * 3 / 4, received / 4); // what the bot worked out per token

        _stake(alice, token, STAKE);
        _stake(bob, token2, STAKE);

        vm.startPrank(feeWallet);
        usdc.approve(address(staking), type(uint256).max);
        staking.notifyReward(address(token), fromToken * 40 / 100);
        staking.notifyReward(address(token2), fromToken2 * 40 / 100);
        vm.stopPrank();

        skip(DRIP);
        assertApproxEqAbs(_claim(alice, token), 300e6, 2);
        assertApproxEqAbs(_claim(bob, token2), 100e6, 2);
        assertEq(usdc.balanceOf(feeWallet), 600e6);
    }

    /// What the contract does if the bot pays a token nobody has staked: it waits, and the first staker gets all of it.
    function test_rewardForAnUnstakedTokenAllGoesToItsFirstStaker() public {
        _reward(token, REWARD);
        skip(30 days);
        _stake(bob, token, 1);
        skip(DRIP);
        assertApproxEqAbs(_claim(bob, token), REWARD, 1);
    }

    // ------------------------------------------------------------------ the books always balance

    function testFuzz_neverPaysMoreThanItTookIn(uint96 a, uint96 b, uint40 reward, uint16 gap1, uint16 gap2) public {
        uint256 aliceStake = bound(a, 1, 1_000_000e18);
        uint256 bobStake = bound(b, 1, 1_000_000e18);
        uint256 amount = bound(reward, 1e6, 1e12);

        _stake(alice, token, aliceStake);
        _reward(token, amount);
        skip(gap1);
        _stake(bob, token, bobStake);
        _reward(token, amount);
        skip(gap2);
        vm.prank(alice);
        staking.unstake(address(token), aliceStake);
        skip(2 * DRIP);

        uint256 total = amount * 2;
        uint256 paid = staking.earned(alice, address(token)) + staking.earned(bob, address(token));
        assertLe(paid, total);
        assertApproxEqAbs(paid, total, 10);
        assertEq(usdc.balanceOf(address(staking)), total);
    }

    // ------------------------------------------------------------------ the list (partner staking only)

    function test_onlyOwnerLists() public {
        TestToken other = new TestToken(18);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        staking.setListed(address(other), true);

        vm.expectEmit(address(staking));
        emit NeuriioPartnerStaking.Listed(address(other), true);
        vm.prank(owner);
        staking.setListed(address(other), true);
        assertTrue(staking.isStakeable(address(other)));
        assertTrue(staking.listed(address(other)));
    }

    function test_cantListTheRewardToken() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(NeuriioPartnerStaking.NotStakeable.selector, address(usdc)));
        staking.setListed(address(usdc), true);
    }

    function test_delistBlocksNewStakesAndRewards() public {
        _stake(alice, token, STAKE);
        vm.prank(owner);
        staking.setListed(address(token), false);
        assertFalse(staking.isStakeable(address(token)));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(NeuriioPartnerStaking.NotStakeable.selector, address(token)));
        staking.stake(address(token), STAKE);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(NeuriioPartnerStaking.NotStakeable.selector, address(token)));
        staking.notifyReward(address(token), REWARD);
    }

    /// Delisting mid-drip: stakers still get everything already paid in, and can always take their tokens back.
    function test_delistedStakersStillEarnTheDripUnstakeAndClaim() public {
        _stake(alice, token, STAKE);
        _reward(token, REWARD);
        skip(DRIP / 2);
        vm.prank(owner);
        staking.setListed(address(token), false);
        skip(DRIP);

        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        staking.unstake(address(token), STAKE);
        assertEq(token.balanceOf(alice) - before, STAKE);
        assertApproxEqAbs(_claim(alice, token), REWARD, 1);
    }

    function test_relistingWorksAgain() public {
        vm.startPrank(owner);
        staking.setListed(address(token), false);
        staking.setListed(address(token), true);
        vm.stopPrank();
        _stake(alice, token, STAKE);
        _reward(token, REWARD);
        skip(DRIP);
        assertApproxEqAbs(_claim(alice, token), REWARD, 1);
    }

    /// The owner can only list: it has no way to take staked tokens or rewards.
    function test_ownerCantTakeAnything() public {
        _stake(alice, token, STAKE);
        _reward(token, REWARD);
        skip(DRIP);
        vm.startPrank(owner);
        vm.expectRevert(NeuriioPartnerStaking.InsufficientStake.selector);
        staking.unstake(address(token), 1);
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        vm.expectRevert(NeuriioPartnerStaking.NothingToClaim.selector);
        staking.claim(tokens, owner);
        vm.stopPrank();
        assertEq(token.balanceOf(address(staking)), STAKE);
        assertEq(usdc.balanceOf(address(staking)), REWARD);
    }
}
