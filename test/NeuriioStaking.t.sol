// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {NeuriioFees} from "../src/launch/NeuriioFees.sol";
import {NeuriioStaking} from "../src/stake/NeuriioStaking.sol";
import {NeuriioMinter} from "../src/stake/NeuriioMinter.sol";
import {NeuriioPlatformToken} from "../src/stake/NeuriioPlatformToken.sol";
import {ICurveFeeVault} from "../src/launch/NeuriioPad.sol";
import {ISwapFactory} from "../src/swap/interfaces.sol";
import {NeuriioBase} from "./Base.t.sol";

/// NeuriioStaking (USDC + $NEURIIO rewards per pool, dripping over an hour), the $NEURIIO token and its minter, and how
/// the NeuriioFees shares every fee: curve 80% $NEURIIO stakers / 10% buyback / 10% treasury; pool 40% $NEURIIO stakers
/// / 40% token stakers / 10% creator / 10% treasury.
contract NeuriioStakingTest is NeuriioBase {
    uint256 constant HOUR = 1 hours;

    function setUp() public override {
        super.setUp();
        usdc.mint(address(this), 10_000_000e6); // to pay rewards in directly
        usdc.approve(address(staking), type(uint256).max);
    }

    /// $NEURIIO can only be minted by the minter: tests that need some mint it as the minter would.
    function _giveNeuriio(address to, uint256 amount) internal {
        vm.prank(address(minter));
        neuriio.mint(to, amount);
    }

    /// A graduated token, with `alice` and `bob` holding some (the pool's opening buys).
    function _graduatedHeld() internal returns (address token) {
        token = _graduated(alice);
        _tradeBuy(bob, token, 500e6);
    }

    function _usdcEarned(address who, address token) internal view returns (uint256 u) {
        (u,) = staking.earned(who, token);
    }

    function _neuEarned(address who, address token) internal view returns (uint256 n) {
        (, n) = staking.earned(who, token);
    }

    // ------------------------------------------------------------------ what can be staked

    function test_stakingOpensAtGraduation() public {
        address token = _launch();
        _buy(alice, token, 1_000e6);
        assertFalse(staking.isStakeable(token));
        vm.startPrank(alice);
        IERC20(token).approve(address(staking), 1e18);
        vm.expectRevert(abi.encodeWithSelector(NeuriioStaking.NotStakeable.selector, token));
        staking.stake(token, 1e18);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(NeuriioStaking.NotStakeable.selector, token));
        staking.notifyReward(token, 1e6);

        _buy(bob, token, 20_000e6); // graduates
        assertTrue(staking.isStakeable(token));
        _stake(alice, token, 1e18);
        assertEq(staking.stakedOf(alice, token), 1e18);
        assertEq(staking.totalStaked(token), 1e18);
        assertEq(IERC20(token).balanceOf(address(staking)), 1e18);
    }

    function test_revert_foreignTokensCantBeStaked() public {
        Plain other = new Plain();
        other.mint(alice, 1e18);
        vm.startPrank(alice);
        other.approve(address(staking), 1e18);
        vm.expectRevert(abi.encodeWithSelector(NeuriioStaking.NotStakeable.selector, address(other)));
        staking.stake(address(other), 1e18);
        usdc.approve(address(staking), 1e6);
        vm.expectRevert(abi.encodeWithSelector(NeuriioStaking.NotStakeable.selector, address(usdc)));
        staking.stake(address(usdc), 1e6); // never USDC itself: rewards are USDC
        vm.stopPrank();
    }

    function test_revert_zeroAndTooMuch() public {
        address token = _graduatedHeld();
        vm.expectRevert(NeuriioStaking.ZeroAmount.selector);
        staking.stake(token, 0);
        _stake(alice, token, 1e18);
        vm.startPrank(alice);
        vm.expectRevert(NeuriioStaking.ZeroAmount.selector);
        staking.unstake(token, 0);
        vm.expectRevert(NeuriioStaking.InsufficientStake.selector);
        staking.unstake(token, 1e18 + 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ rewards drip over an hour

    function test_rewardsDripOverAnHour() public {
        address token = _graduatedHeld();
        _stake(alice, token, 1_000e18);
        staking.notifyReward(token, 36e6);
        (uint256 remaining,) = staking.dripping(token);
        assertEq(remaining, 36e6);

        skip(HOUR / 2);
        assertApproxEqAbs(_usdcEarned(alice, token), 18e6, 10);
        (remaining,) = staking.dripping(token);
        assertEq(remaining, 18e6);
        skip(HOUR / 2);
        assertApproxEqAbs(_usdcEarned(alice, token), 36e6, 10);
        skip(5 * HOUR); // nothing more after the drip ends
        assertApproxEqAbs(_usdcEarned(alice, token), 36e6, 10);

        uint256 before = usdc.balanceOf(alice);
        address[] memory pools = new address[](1);
        pools[0] = token;
        vm.prank(alice);
        (uint256 got,) = staking.claim(pools, alice);
        assertEq(usdc.balanceOf(alice) - before, got);
        assertApproxEqAbs(got, 36e6, 10);
        assertEq(_usdcEarned(alice, token), 0);
        vm.prank(alice);
        vm.expectRevert(NeuriioStaking.NothingToClaim.selector);
        staking.claim(pools, alice);
    }

    function test_stakersShareProRata() public {
        address token = _graduatedHeld();
        _stake(alice, token, 1_000e18);
        _stake(bob, token, 3_000e18);
        staking.notifyReward(token, 4e6);
        skip(HOUR);
        assertApproxEqAbs(_usdcEarned(alice, token), 1e6, 10);
        assertApproxEqAbs(_usdcEarned(bob, token), 3e6, 10);
    }

    /// Staking for a moment around a big payment catches almost none of it: it drips to whoever stays.
    function test_flashStakeCatchesAlmostNothing() public {
        address token = _graduatedHeld();
        _stake(alice, token, 1_000e18);
        _stake(bob, token, 1_000e18); // bob jumps in right before a big fee...
        staking.notifyReward(token, 100e6);
        skip(1); // ...and out the next second
        vm.prank(bob);
        staking.unstake(token, 1_000e18);
        skip(HOUR);
        assertLt(_usdcEarned(bob, token), 0.02e6); // ~half of one second's drip
        assertApproxEqAbs(_usdcEarned(alice, token) + _usdcEarned(bob, token), 100e6, 10);
    }

    /// If everyone leaves mid-drip, the rest waits for the next stakers instead of being lost.
    function test_emptyPoolHoldsTheRestOfTheDrip() public {
        address token = _graduatedHeld();
        _stake(alice, token, 1_000e18);
        staking.notifyReward(token, 36e6);
        skip(HOUR / 2);
        vm.prank(alice);
        staking.unstake(token, 1_000e18);
        assertApproxEqAbs(_usdcEarned(alice, token), 18e6, 10); // kept after unstaking
        skip(10 * HOUR);
        (uint256 remaining,) = staking.dripping(token);
        assertApproxEqAbs(remaining, 18e6, 10); // on hold
        _stake(bob, token, 1e18);
        skip(HOUR);
        assertApproxEqAbs(_usdcEarned(bob, token), 18e6, 10);
    }

    /// Random stakes, unstakes, payments, time and claims: the contract always holds what it owes, and the USDC paid
    /// out plus the USDC still held equals everything paid in.
    function testFuzz_stakingStaysSolvent(uint256 seed) public {
        address token = _graduatedHeld();
        address[3] memory who = [alice, bob, creator];
        uint256 third = IERC20(token).balanceOf(alice) / 3;
        vm.prank(alice);
        IERC20(token).transfer(creator, third);
        for (uint256 i; i < 3; i++) {
            vm.prank(who[i]);
            IERC20(token).approve(address(staking), type(uint256).max);
        }
        uint256 paidIn;
        uint256 paidOut;
        address[] memory pools = new address[](1);
        pools[0] = token;
        for (uint256 i; i < 40; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address w = who[seed % 3];
            uint256 op = (seed >> 8) % 5;
            if (op == 0) {
                uint256 bal = IERC20(token).balanceOf(w);
                if (bal > 0) {
                    vm.prank(w);
                    staking.stake(token, bound(seed >> 16, 1, bal));
                }
            } else if (op == 1) {
                uint256 st = staking.stakedOf(w, token);
                if (st > 0) {
                    vm.prank(w);
                    staking.unstake(token, bound(seed >> 16, 1, st));
                }
            } else if (op == 2) {
                uint256 amount = bound(seed >> 16, 1, 50_000e6);
                staking.notifyReward(token, amount);
                paidIn += amount;
            } else if (op == 3) {
                skip(bound(seed >> 16, 1, 2 * HOUR));
            } else if (_usdcEarned(w, token) > 0) {
                uint256 before = usdc.balanceOf(w);
                vm.prank(w);
                staking.claim(pools, w);
                paidOut += usdc.balanceOf(w) - before;
            }
            uint256 owed = _usdcEarned(alice, token) + _usdcEarned(bob, token) + _usdcEarned(creator, token);
            (uint256 remaining,) = staking.dripping(token);
            uint256 bal = usdc.balanceOf(address(staking));
            assertGe(bal + 10, owed + remaining, "holds what it owes");
            assertEq(bal + paidOut, paidIn, "in = out + held");
        }
    }

    // ------------------------------------------------------------------ $NEURIIO: minted by staking X tokens

    /// Pool fee 10 USDC: the token's stakers earn 4 USDC and mint 100 $NEURIIO (25 per $1), dripping over an hour;
    /// claiming sends the USDC to the wallet and stakes the $NEURIIO.
    function test_xStakersMint100PerDollarEarned() public {
        address token = _graduatedHeld();
        _stake(alice, token, 1_000e18);
        _tradeBuy(bob, token, 1_000e6); // fee 10
        assertEq(vault.holdersEarned(token), 4e6);
        assertEq(neuriio.totalSupply(), 100e18);
        (, uint256 neuDripping) = staking.dripping(token);
        assertApproxEqAbs(neuDripping, 100e18, 1e6); // the drip rate rounds down by a few wei
        skip(HOUR);
        assertApproxEqAbs(_usdcEarned(alice, token), 4e6, 10);
        assertApproxEqAbs(_neuEarned(alice, token), 100e18, 1e9);

        address[] memory pools = new address[](1);
        pools[0] = token;
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        (uint256 u, uint256 n) = staking.claim(pools, alice);
        assertEq(usdc.balanceOf(alice) - before, u);
        assertEq(neuriio.balanceOf(alice), 0, "claimed $NEURIIO is staked, not sent");
        assertEq(staking.stakedOf(alice, address(neuriio)), n);
        assertApproxEqAbs(n, 100e18, 1e9);
    }

    /// Two stakers mint in proportion to their stake.
    function test_mintIsProRata() public {
        address token = _graduatedHeld();
        _stake(alice, token, 1_000e18);
        _stake(bob, token, 3_000e18);
        _tradeBuy(creator, token, 1_000e6);
        skip(HOUR);
        assertApproxEqAbs(_neuEarned(alice, token), 25e18, 1e9);
        assertApproxEqAbs(_neuEarned(bob, token), 75e18, 1e9);
    }

    /// Curve fees mint nothing (nobody can stake a token on its curve) but move the curve; staking $NEURIIO earns USDC
    /// and mints nothing.
    function test_onlyXStakersMint() public {
        address token = _launch();
        _buy(alice, token, 1_010e6); // curve fee 10
        assertEq(neuriio.totalSupply(), 0);
        assertEq(minter.totalFees(), 10e18, "curve fees move the curve");

        _giveNeuriio(bob, 1e18);
        vm.prank(bob);
        staking.stake(address(neuriio), 1e18);
        _buy(alice, token, 1_010e6);
        assertEq(vault.stakersEarned(), 8e6);
        assertEq(neuriio.totalSupply(), 1e18, "staking $NEURIIO mints nothing");
        skip(HOUR);
        assertApproxEqAbs(_usdcEarned(bob, address(neuriio)), 8e6, 10);
        assertEq(_neuEarned(bob, address(neuriio)), 0);
    }

    function test_revert_onlyTheMinterAddsNeuriio() public {
        address token = _graduatedHeld();
        vm.expectRevert(NeuriioStaking.NotMinter.selector);
        staking.notifyNeuriio(token, 1e18);
        vm.prank(address(minter));
        vm.expectRevert(abi.encodeWithSelector(NeuriioStaking.NotStakeable.selector, address(neuriio)));
        staking.notifyNeuriio(address(neuriio), 1e18);
        vm.expectRevert(NeuriioMinter.NotVault.selector);
        minter.onFee(token, 1e6, 1e6);
        vm.prank(owner);
        vm.expectRevert(NeuriioPlatformToken.NotMinter.selector);
        neuriio.mint(owner, 1);
    }

    /// PAPER's decay: flat at 25 per $1 until $1M of platform fees, then 25 x (S / (S + h))^2.
    function test_mintRateDecay() public {
        MinterHarness h = new MinterHarness(owner, staking, MINT_RATE, FLAT_UNTIL, DECAY_SCALE);
        assertEq(h.rateNow(), 25e18);
        h.setTotalFees(999_999e18);
        assertEq(h.rateNow(), 25e18);
        h.setTotalFees(31_000_000e18); // $30M past the flat part: 25 x (120/150)^2 = 16
        assertApproxEqRel(h.rateNow(), 16e18, 1e12);
        h.setTotalFees(101_000_000e18); // $100M past it: 25 x (120/220)^2 ~= 7.44
        assertApproxEqRel(h.rateNow(), 7.4380165e18, 1e12);
    }

    /// Never more than 25 per $1, and never past the 1B supply: the last mint is cut to what's left, then nothing.
    function test_rateCapAndSupplyCap() public {
        vm.prank(owner);
        vm.expectRevert(NeuriioMinter.InvalidParams.selector);
        minter.setMintCurve(25e18 + 1, FLAT_UNTIL, DECAY_SCALE);
        vm.expectRevert(NeuriioMinter.InvalidParams.selector);
        new NeuriioMinter(owner, staking, 26e18, FLAT_UNTIL, DECAY_SCALE);

        address token = _graduatedHeld();
        _stake(alice, token, 1_000e18);
        _giveNeuriio(bob, neuriio.MAX_SUPPLY() - 10e18); // 10 $NEURIIO left under the cap
        _tradeBuy(creator, token, 1_000e6); // stakers earn 4 USDC: would mint 100, only 10 fit
        assertEq(neuriio.totalSupply(), neuriio.MAX_SUPPLY());
        uint256 earnedBefore = vault.holdersEarned(token);
        _tradeBuy(creator, token, 1_000e6); // at the cap: USDC still flows, nothing more is minted
        assertEq(neuriio.totalSupply(), neuriio.MAX_SUPPLY());
        assertGt(vault.holdersEarned(token), earnedBefore);
        vm.prank(address(minter));
        vm.expectRevert(NeuriioPlatformToken.SupplyCapReached.selector);
        neuriio.mint(bob, 1);
    }

    /// The owner can fix the minter for good.
    function test_lockMinter() public {
        vm.startPrank(owner);
        neuriio.lockMinter();
        vm.expectRevert(NeuriioPlatformToken.MinterIsLocked.selector);
        neuriio.setMinter(owner);
        vm.stopPrank();
        assertEq(neuriio.minter(), address(minter));
    }

    function test_mintCurveAdmin() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        minter.setMintCurve(1, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        minter.setVault(alice, true);
        vm.startPrank(owner);
        vm.expectRevert(NeuriioMinter.InvalidParams.selector);
        minter.setMintCurve(26e18, 1, 1);
        minter.setMintCurve(20e18, 10e18, 20e18);
        assertEq(minter.mintRate(), 20e18);
        minter.freezeMintCurve();
        vm.expectRevert(NeuriioMinter.MintCurveIsFrozen.selector);
        minter.setMintCurve(100e18, 1, 1);
        vm.stopPrank();
    }

    /// A vault the minter doesn't know still shares fees; it just can't mint (and trading never stops).
    function test_unapprovedVaultStillTrades() public {
        address token = _graduatedHeld();
        _stake(alice, token, 1_000e18);
        vm.prank(owner);
        minter.setVault(address(vault), false);
        _tradeBuy(bob, token, 1_000e6);
        assertEq(vault.holdersEarned(token), 4e6);
        assertEq(neuriio.totalSupply(), 0);
    }

    // ------------------------------------------------------------------ $NEURIIO token

    function test_neuriioToken() public {
        assertEq(neuriio.name(), "Neuriio");
        assertEq(neuriio.symbol(), "NEURIIO");
        assertEq(neuriio.totalSupply(), 0); // nothing exists until X-token stakers earn fees
        assertEq(neuriio.staking(), address(staking));
        assertEq(neuriio.minter(), address(minter));
        assertEq(neuriio.owner(), owner);
    }

    function test_neuriioCantBeSentButStakesWithoutApproval() public {
        _giveNeuriio(alice, 100e18);
        assertEq(neuriio.allowance(alice, address(staking)), type(uint256).max);
        vm.startPrank(alice);
        vm.expectRevert(NeuriioPlatformToken.NotTransferable.selector);
        neuriio.transfer(bob, 1);
        vm.expectRevert(NeuriioPlatformToken.NotTransferable.selector);
        neuriio.transfer(address(staking), 1); // only through stake()
        staking.stake(address(neuriio), 60e18); // no approve needed
        staking.unstake(address(neuriio), 60e18);
        vm.stopPrank();
        assertEq(neuriio.balanceOf(alice), 100e18);
    }

    function test_neuriioOwnerSwitches() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        neuriio.enableTransfers();
        _giveNeuriio(alice, 10e18);
        vm.prank(owner);
        neuriio.enableTransfers(); // once and for good
        vm.prank(alice);
        neuriio.transfer(bob, 4e18);
        assertEq(neuriio.balanceOf(bob), 4e18);
    }

    // ------------------------------------------------------------------ the fee split (NeuriioFees)

    /// Curve fee: 80% $NEURIIO stakers, 10% KNTQ buyback, 10% treasury.
    function test_curveFeeSplit() public {
        address token = _launch();
        _giveNeuriio(bob, 1e18);
        vm.prank(bob);
        staking.stake(address(neuriio), 1e18);
        _buy(alice, token, 1_010e6); // fee 10
        assertEq(vault.stakersEarned(), 8e6);
        assertEq(vault.buybackBalance(), 1e6);
        assertEq(vault.treasuryBalance(), 1e6);
        assertEq(vault.creatorBalance(creator), 0);
        assertEq(usdc.balanceOf(address(staking)), 8e6);
    }

    /// Pool fee: 40% $NEURIIO stakers, 40% token stakers, 10% creator, 10% treasury.
    function test_poolFeeSplit() public {
        address token = _graduatedHeld();
        _stake(alice, token, 1_000e18);
        _giveNeuriio(bob, 1e18);
        vm.prank(bob);
        staking.stake(address(neuriio), 1e18);
        uint256 creatorBefore = vault.creatorBalance(creator);
        uint256 treasuryBefore = vault.treasuryBalance();
        uint256 stakersBefore = vault.stakersEarned();
        uint256 buybackBefore = vault.buybackBalance();

        _tradeBuy(bob, token, 100e6); // fee 1
        assertEq(vault.creatorBalance(creator) - creatorBefore, 0.1e6);
        assertEq(vault.holdersEarned(token), 0.4e6);
        assertEq(vault.stakersEarned() - stakersBefore, 0.4e6);
        assertEq(vault.treasuryBalance() - treasuryBefore, 0.1e6);
        assertEq(vault.buybackBalance(), buybackBefore, "no buyback share in the pool");
    }

    /// Nobody stakes the token: its 40% goes to $NEURIIO stakers (and mints nothing); nobody stakes $NEURIIO: treasury.
    function test_unclaimedSharesMoveDownTheLine() public {
        address token = _graduatedHeld();
        uint256 treasuryBefore = vault.treasuryBalance();
        _tradeBuy(bob, token, 100e6);
        assertEq(vault.treasuryBalance() - treasuryBefore, 0.9e6); // 10% + 40% + 40%

        _giveNeuriio(bob, 1e18);
        vm.prank(bob);
        staking.stake(address(neuriio), 1e18);
        treasuryBefore = vault.treasuryBalance();
        uint256 stakersBefore = vault.stakersEarned();
        uint256 supply = neuriio.totalSupply();
        _tradeBuy(bob, token, 100e6);
        assertEq(vault.stakersEarned() - stakersBefore, 0.8e6);
        assertEq(vault.treasuryBalance() - treasuryBefore, 0.1e6);
        assertEq(neuriio.totalSupply(), supply, "no token stakers, nothing minted");
    }

    /// If NeuriioStaking ever fails, its shares go to the treasury and trading carries on.
    function test_brokenStakingNeverStopsTrading() public {
        address token = _graduatedHeld();
        BrokenStaking broken = new BrokenStaking(address(neuriio));
        NeuriioFees v = new NeuriioFees(
            owner,
            IERC20(address(usdc)),
            ISwapFactory(address(factory)),
            registry,
            NeuriioStaking(address(broken)),
            minter
        );
        vm.startPrank(owner);
        factory.setFeeVault(address(v));
        pad.setFeeVault(ICurveFeeVault(address(v)));
        vm.stopPrank();

        uint256 out = _tradeBuy(bob, token, 100e6);
        assertGt(out, 0);
        assertEq(v.creatorBalance(creator), 0.1e6);
        assertEq(v.treasuryBalance(), 0.9e6);
        assertEq(usdc.balanceOf(address(v)), v.held());

        address fresh = _launch(); // curve trades too
        _buy(alice, fresh, 1_000e6);
        assertGt(v.feesOf(fresh), 0);
    }

    /// Random trading on the curve and in the pool, with stakers coming and going: the vault holds exactly what it owes,
    /// staking received exactly the stakers' shares, and every $NEURIIO minted sits in staking.
    function testFuzz_feesAlwaysAddUp(uint256 seed) public {
        address token = _launch();
        address[2] memory who = [alice, bob];
        for (uint256 i; i < 2; i++) {
            vm.startPrank(who[i]);
            IERC20(token).approve(address(trade), type(uint256).max);
            IERC20(token).approve(address(staking), type(uint256).max);
            vm.stopPrank();
        }
        address[] memory pools = new address[](1);
        pools[0] = token;
        for (uint256 i; i < 30; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address w = who[seed % 2];
            uint256 bal = IERC20(token).balanceOf(w);
            uint256 op = (seed >> 8) % 5;
            if (op <= 1) {
                _tradeBuy(w, token, bound(seed >> 16, 1e3, 8_000e6)); // may graduate it
            } else if (op == 2 && bal > 0) {
                vm.prank(w);
                trade.sell(token, bound(seed >> 16, 1e12, bal), 0, block.timestamp);
            } else if (op == 3 && bal > 0 && _curve(token).graduated) {
                vm.prank(w);
                staking.stake(token, bound(seed >> 16, 1, bal));
            } else if (op == 4) {
                skip(bound(seed >> 16, 1, 2 hours));
                (uint256 u, uint256 n) = staking.earned(w, token);
                if (u + n > 0) {
                    vm.prank(w);
                    staking.claim(pools, w); // its $NEURIIO gets staked
                }
            }
            assertEq(usdc.balanceOf(address(vault)), vault.held(), "vault holds exactly what it owes");
            assertEq(
                vault.held(),
                vault.creatorBalance(creator) + vault.treasuryBalance() + vault.buybackBalance(),
                "owed = creator + treasury + buyback"
            );
            assertEq(neuriio.balanceOf(address(staking)), neuriio.totalSupply(), "every $NEURIIO is in staking");
            assertEq(minter.totalFees(), vault.totalFees() * 1e12, "the curve saw every fee");
        }
    }
}

contract Plain is ERC20("Plain", "PLN") {
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// A NeuriioStaking that says someone is staked but rejects every reward.
contract BrokenStaking {
    address public neuriio;

    constructor(address neuriio_) {
        neuriio = neuriio_;
    }

    function totalStaked(address) external pure returns (uint256) {
        return 1;
    }

    function notifyReward(address, uint256) external pure {
        revert("broken");
    }
}

/// NeuriioMinter with a way to jump the curve to any point.
contract MinterHarness is NeuriioMinter {
    constructor(address owner_, NeuriioStaking staking_, uint256 rate, uint256 flatUntil_, uint256 decayScale_)
        NeuriioMinter(owner_, staking_, rate, flatUntil_, decayScale_)
    {}

    function setTotalFees(uint256 x) external {
        totalFees = x;
    }
}
