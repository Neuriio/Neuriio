// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NeuriioPad} from "../../src/launch/NeuriioPad.sol";
import {NeuriioFees} from "../../src/launch/NeuriioFees.sol";
import {NeuriioRegistry} from "../../src/launch/NeuriioRegistry.sol";
import {NeuriioRouter} from "../../src/swap/NeuriioRouter.sol";
import {NeuriioStaking} from "../../src/stake/NeuriioStaking.sol";
import {NeuriioPlatformToken} from "../../src/stake/NeuriioPlatformToken.sol";
import {TestUSDC} from "../../src/testnet/TestUSDC.sol";
import {ISwapFactory} from "../../src/swap/interfaces.sol";
import {NeuriioBase} from "../Base.t.sol";

/// Random launches (personal + one FTF), curve and pool trades through the router and the pad, graduations,
/// stakes, unstakes, claims, creator claims, payouts, donations to NeuriioFees and to staking, and time jumps.
contract AuditInvariantHandler is Test {
    uint256 constant LP_SUPPLY = 206_900_000e18;

    NeuriioPad public pad;
    NeuriioRouter public trade;
    NeuriioFees public vault;
    NeuriioStaking public staking;
    NeuriioPlatformToken public neuriio;
    TestUSDC public usdc;
    ISwapFactory public factory;
    uint256 signerPk;

    address[] public actors;
    address[] public tokens;
    address[] public creators;
    bool ftfLaunched;
    uint64 nextXId = 50_000;

    // ghosts
    mapping(address token => uint256) public lastK;
    bool public kDecreased;
    bool public sellBackFailed;
    bytes public unexpected; // revert data of the first call that should never have failed
    uint256 public paidToProtocol;
    uint256 public calls;
    // successful actions, to show the campaign isn't vacuous
    uint256 public graduations;
    uint256 public curveTrades;
    uint256 public poolTrades;
    uint256 public stakes;
    uint256 public rewardClaims;

    constructor(
        NeuriioPad pad_,
        NeuriioRouter trade_,
        NeuriioFees vault_,
        NeuriioStaking staking_,
        TestUSDC usdc_,
        ISwapFactory factory_,
        uint256 signerPk_
    ) {
        (pad, trade, vault, staking, usdc, factory, signerPk) =
        (pad_, trade_, vault_, staking_, usdc_, factory_, signerPk_);
        neuriio = staking_.neuriio();
    }

    /// Called once the handler may mint test USDC.
    function init() external {
        for (uint256 i; i < 4; ++i) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(a);
            _fund(a, 5_000_000e6);
        }
    }

    /// Records a revert that no valid input should cause (the handler's own calls swallow reverts otherwise).
    function _unexpected(bytes memory err) internal {
        if (unexpected.length == 0) unexpected = err.length == 0 ? bytes("empty revert") : err;
    }

    /// Curve and pool trades may refuse amounts that round to nothing; anything else is a bug.
    function _tradeRevert(bytes memory err) internal {
        bytes4 sel = bytes4(err);
        if (sel == NeuriioPad.ZeroAmount.selector || sel == NeuriioRouter.ZeroAmount.selector) return;
        if (
            keccak256(err)
                == keccak256(abi.encodeWithSignature("Error(string)", "UniswapV2: INSUFFICIENT_OUTPUT_AMOUNT"))
        ) {
            return;
        }
        _unexpected(err);
    }

    function _topUp(address who) internal {
        if (usdc.balanceOf(who) < 200_000e6) usdc.mint(who, 1_000_000e6);
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.startPrank(who);
        usdc.approve(address(trade), type(uint256).max);
        usdc.approve(address(pad), type(uint256).max);
        usdc.approve(address(staking), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ views for the invariants

    function tokensLength() external view returns (uint256) {
        return tokens.length;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function creatorsLength() external view returns (uint256) {
        return creators.length;
    }

    function curveOf(address token) public view returns (NeuriioPad.Curve memory c) {
        (c.creator, c.graduated, c.virtualQuote, c.virtualToken, c.realQuote, c.realToken) = pad.curves(token);
    }

    // ------------------------------------------------------------------ actions

    function launch(uint256 seed) external {
        if (tokens.length >= 6) return;
        calls++;
        address who = makeAddr(string.concat("creator", vm.toString(nextXId)));
        _fund(who, 100_000e6);
        NeuriioPad.LaunchPass memory p = NeuriioPad.LaunchPass({
            creator: who,
            xUserId: nextXId,
            handle: string.concat("h", vm.toString(nextXId)),
            category: uint8(seed % 6),
            profileHash: bytes32(seed),
            deadline: block.timestamp + 15 minutes
        });
        nextXId++;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, pad.hashLaunchPass(p));
        vm.prank(who);
        address token = pad.launch(p, abi.encodePacked(r, s, v), bound(seed, 0, 3_000e6), 0);
        tokens.push(token);
        creators.push(who);
        _checkK(token);
    }

    function launchFtf(uint256 seed) external {
        if (ftfLaunched || tokens.length >= 6) return;
        calls++;
        ftfLaunched = true;
        address[4] memory members;
        uint64[4] memory ids;
        for (uint256 i; i < 4; ++i) {
            members[i] = makeAddr(string.concat("ftfmember", vm.toString(i)));
            ids[i] = uint64(90_000 + i);
            _fund(members[i], 100_000e6);
            creators.push(members[i]);
        }
        NeuriioPad.FtfPass memory p = NeuriioPad.FtfPass({
            founder: members[0],
            name: "Fuzz Fam",
            ticker: "FUZZ",
            memberXIds: ids,
            members: members,
            profileHash: bytes32(seed),
            deadline: block.timestamp + 15 minutes
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, pad.hashFtfPass(p));
        vm.prank(members[0]);
        address token = pad.launchFtf(p, abi.encodePacked(r, s, v), bound(seed, 0, 3_000e6), 0);
        tokens.push(token);
        _checkK(token);
    }

    /// A buy through the router (curve or pool) or straight from the pad; big amounts graduate the token.
    function buy(uint256 actorSeed, uint256 tokenSeed, uint256 amount, bool direct) external {
        if (tokens.length == 0) return;
        calls++;
        address a = actors[actorSeed % actors.length];
        address token = tokens[tokenSeed % tokens.length];
        // a third of the buys may be big enough to graduate a curve (~14.2k USDC at VQ 5,000)
        amount = amount % 3 == 0 ? bound(amount, 1, 40_000e6) : bound(amount, 1, 1_500e6);
        _topUp(a);
        bool onCurve = !curveOf(token).graduated;
        vm.prank(a);
        if (onCurve && direct) {
            try pad.buy(token, amount, 0, block.timestamp) {
                curveTrades++;
            } catch (bytes memory err) {
                _tradeRevert(err);
            }
        } else {
            try trade.buy(token, amount, 0, block.timestamp) {
                if (onCurve) curveTrades++;
                else poolTrades++;
            } catch (bytes memory err) {
                _tradeRevert(err);
            }
        }
        if (onCurve && curveOf(token).graduated) graduations++;
        if (onCurve) _checkK(token);
    }

    function sell(uint256 actorSeed, uint256 tokenSeed, uint256 pct, bool direct) external {
        if (tokens.length == 0) return;
        calls++;
        address a = actors[actorSeed % actors.length];
        address token = tokens[tokenSeed % tokens.length];
        uint256 amount = IERC20(token).balanceOf(a) * bound(pct, 1, 100) / 100;
        if (amount == 0) return;
        bool onCurve = !curveOf(token).graduated;
        vm.startPrank(a);
        if (onCurve && direct) {
            IERC20(token).approve(address(pad), amount);
            try pad.sell(token, amount, 0, block.timestamp) {
                curveTrades++;
            } catch (bytes memory err) {
                _tradeRevert(err);
            }
        } else {
            IERC20(token).approve(address(trade), amount);
            try trade.sell(token, amount, 0, block.timestamp) {
                if (onCurve) curveTrades++;
                else poolTrades++;
            } catch (bytes memory err) {
                _tradeRevert(err);
            }
        }
        vm.stopPrank();
        if (onCurve) _checkK(token);
    }

    /// Everyone holding a live curve's token sells all of it back to the curve: none may fail (dust that rounds to
    /// zero USDC is the only allowed refusal).
    function sellEverythingBack(uint256 tokenSeed) external {
        if (tokens.length == 0) return;
        address token = tokens[tokenSeed % tokens.length];
        if (curveOf(token).graduated) return;
        calls++;
        for (uint256 i; i < actors.length + creators.length; ++i) {
            address a = i < actors.length ? actors[i] : creators[i - actors.length];
            uint256 bal = IERC20(token).balanceOf(a);
            if (bal == 0) continue;
            vm.startPrank(a);
            IERC20(token).approve(address(pad), bal);
            try pad.sell(token, bal, 0, block.timestamp) {}
            catch (bytes memory err) {
                if (bytes4(err) != NeuriioPad.ZeroAmount.selector) sellBackFailed = true;
            }
            vm.stopPrank();
        }
        _checkK(token);
    }

    function stake(uint256 actorSeed, uint256 tokenSeed, uint256 pct) external {
        if (tokens.length == 0) return;
        address a = actors[actorSeed % actors.length];
        address token = tokens[tokenSeed % tokens.length];
        if (!curveOf(token).graduated) return;
        uint256 amount = IERC20(token).balanceOf(a) * bound(pct, 1, 100) / 100;
        if (amount == 0) return;
        calls++;
        vm.startPrank(a);
        IERC20(token).approve(address(staking), amount);
        try staking.stake(token, amount) {
            stakes++;
        } catch (bytes memory err) {
            _unexpected(err);
        }
        vm.stopPrank();
    }

    /// Unstakes from a token's pool, or (tokenSeed % 7 == 6) from the $NEURIIO pool; restakes some $NEURIIO sometimes.
    function unstake(uint256 actorSeed, uint256 tokenSeed, uint256 pct) external {
        address a = actors[actorSeed % actors.length];
        address token = tokenSeed % 7 == 6 || tokens.length == 0 ? address(neuriio) : tokens[tokenSeed % tokens.length];
        uint256 amount = staking.stakedOf(a, token) * bound(pct, 1, 100) / 100;
        if (amount == 0) return;
        calls++;
        vm.startPrank(a);
        try staking.unstake(token, amount) {}
        catch (bytes memory err) {
            _unexpected(err);
        }
        if (token == address(neuriio) && pct % 2 == 0) {
            try staking.stake(token, amount / 2 + 1) {}
            catch (bytes memory err) {
                _unexpected(err);
            }
        }
        vm.stopPrank();
    }

    function claim(uint256 actorSeed) external {
        address a = actors[actorSeed % actors.length];
        address[] memory pools = new address[](tokens.length + 1);
        for (uint256 i; i < tokens.length; ++i) {
            pools[i] = tokens[i];
        }
        pools[tokens.length] = address(neuriio);
        calls++;
        vm.prank(a);
        try staking.claim(pools, a) {
            rewardClaims++;
        } catch (bytes memory err) {
            if (bytes4(err) != NeuriioStaking.NothingToClaim.selector) _unexpected(err);
        }
    }

    function creatorClaim(uint256 seed) external {
        if (creators.length == 0) return;
        address c = creators[seed % creators.length];
        if (vault.creatorBalance(c) == 0) return;
        calls++;
        vm.prank(c);
        try vault.claim(c) {}
        catch (bytes memory err) {
            _unexpected(err);
        }
    }

    function payProtocol() external {
        uint256 owed = vault.treasuryBalance() + vault.buybackBalance();
        calls++;
        try vault.payProtocol() {
            paidToProtocol += owed;
        } catch (bytes memory err) {
            _unexpected(err);
        }
    }

    /// USDC sent straight to NeuriioFees: credited to whatever token notifies next.
    function donateToVault(uint256 actorSeed, uint256 amount) external {
        address a = actors[actorSeed % actors.length];
        amount = bound(amount, 1, 50_000e6);
        _topUp(a);
        calls++;
        vm.prank(a);
        usdc.transfer(address(vault), amount);
    }

    /// Anyone may add USDC rewards to an open pool.
    function donateToStakers(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        address a = actors[actorSeed % actors.length];
        address token = tokenSeed % 7 == 6 || tokens.length == 0 ? address(neuriio) : tokens[tokenSeed % tokens.length];
        if (!staking.isStakeable(token)) return;
        amount = bound(amount, 1, 10_000e6);
        _topUp(a);
        calls++;
        vm.prank(a);
        try staking.notifyReward(token, amount) {}
        catch (bytes memory err) {
            _unexpected(err);
        }
    }

    function warp(uint256 secs) external {
        calls++;
        vm.warp(block.timestamp + bound(secs, 1, 3 hours));
    }

    // ------------------------------------------------------------------ internals

    function _checkK(address token) internal {
        NeuriioPad.Curve memory c = curveOf(token);
        if (c.graduated) return;
        uint256 k = uint256(c.virtualQuote) * c.virtualToken;
        if (k < lastK[token]) kDecreased = true;
        lastK[token] = k;
    }
}

/// The invariants every state reachable by the handler must satisfy.
contract AuditInvariantsTest is NeuriioBase {
    uint256 constant LP_SUPPLY = 206_900_000e18;
    uint256 constant VIRTUAL_TOKENS = 1_073_000_000e18;
    uint256 constant CURVE_SUPPLY = 793_100_000e18;
    AuditInvariantHandler handler;

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        vault.setWallets(treasury, makeAddr("buyback"));
        handler = new AuditInvariantHandler(pad, trade, vault, staking, usdc, ISwapFactory(address(factory)), signerPk);
        vm.prank(owner);
        usdc.setMinter(address(handler), true);
        handler.init();
        bytes4[] memory sel = new bytes4[](14);
        sel[0] = handler.launch.selector;
        sel[1] = handler.launchFtf.selector;
        sel[2] = handler.buy.selector;
        sel[3] = handler.buy.selector; // buys twice as likely
        sel[4] = handler.sell.selector;
        sel[5] = handler.sellEverythingBack.selector;
        sel[6] = handler.stake.selector;
        sel[7] = handler.unstake.selector;
        sel[8] = handler.claim.selector;
        sel[9] = handler.creatorClaim.selector;
        sel[10] = handler.payProtocol.selector;
        sel[11] = handler.donateToVault.selector;
        sel[12] = handler.donateToStakers.selector;
        sel[13] = handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// The pad holds every live curve's USDC and its unsold + pool tokens.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    function invariant_Audit_padSolvent() public view {
        uint256 owed;
        for (uint256 i; i < handler.tokensLength(); ++i) {
            address t = handler.tokens(i);
            NeuriioPad.Curve memory c = handler.curveOf(t);
            if (c.graduated) {
                assertEq(c.realQuote, 0);
                assertEq(c.realToken, 0);
                continue;
            }
            owed += c.realQuote;
            assertGe(IERC20(t).balanceOf(address(pad)), LP_SUPPLY + c.realToken, "pad short of tokens");
        }
        assertGe(usdc.balanceOf(address(pad)), owed, "pad short of USDC");
    }

    /// Virtual reserves track real ones exactly, and k never falls below its launch value (so everyone can sell back).
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    function invariant_Audit_curveReserves() public view {
        assertFalse(handler.kDecreased(), "k decreased");
        assertFalse(handler.sellBackFailed(), "a holder couldn't sell back");
        for (uint256 i; i < handler.tokensLength(); ++i) {
            NeuriioPad.Curve memory c = handler.curveOf(handler.tokens(i));
            if (c.graduated) continue;
            assertEq(c.virtualQuote - c.realQuote, VQ);
            assertEq(c.virtualToken - c.realToken, VIRTUAL_TOKENS - CURVE_SUPPLY);
            assertGe(uint256(c.virtualQuote) * c.virtualToken, VQ * VIRTUAL_TOKENS);
        }
    }

    /// NeuriioFees holds what it owes, and owes exactly creators + treasury + buyback.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    function invariant_Audit_feesHeld() public view {
        uint256 creatorsOwed;
        for (uint256 i; i < handler.creatorsLength(); ++i) {
            creatorsOwed += vault.creatorBalance(handler.creators(i));
        }
        assertEq(vault.held(), creatorsOwed + vault.treasuryBalance() + vault.buybackBalance(), "held");
        assertGe(usdc.balanceOf(address(vault)), vault.held(), "vault short");
    }

    /// Every fee ever credited went somewhere: creators, token stakers, $NEURIIO stakers, treasury, buyback.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    function invariant_Audit_feesAddUp() public view {
        uint256 sum =
            vault.stakersEarned() + vault.treasuryBalance() + vault.buybackBalance() + handler.paidToProtocol();
        for (uint256 i; i < handler.tokensLength(); ++i) {
            address t = handler.tokens(i);
            sum += vault.creatorEarned(t) + vault.holdersEarned(t);
        }
        assertEq(vault.totalFees(), sum);
    }

    /// NeuriioStaking can pay every reward earned or still dripping, in USDC and in $NEURIIO, and every stake.
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    function invariant_Audit_stakingSolvent() public view {
        uint256 n = handler.tokensLength();
        address[] memory pools = new address[](n + 1);
        for (uint256 i; i < n; ++i) {
            pools[i] = handler.tokens(i);
        }
        pools[n] = address(neuriio);
        uint256 usdcOwed;
        uint256 neuOwed = staking.totalStaked(address(neuriio));
        for (uint256 j; j < pools.length; ++j) {
            (uint256 du, uint256 dn) = staking.dripping(pools[j]);
            usdcOwed += du;
            neuOwed += dn;
            uint256 staked;
            for (uint256 i; i < handler.actorsLength(); ++i) {
                address a = handler.actors(i);
                (uint256 u, uint256 m) = staking.earned(a, pools[j]);
                usdcOwed += u;
                neuOwed += m;
                staked += staking.stakedOf(a, pools[j]);
            }
            assertEq(staked, staking.totalStaked(pools[j]), "stakes don't add up");
            if (pools[j] != address(neuriio)) {
                assertGe(IERC20(pools[j]).balanceOf(address(staking)), staked, "staking short of tokens");
            }
        }
        assertGe(usdc.balanceOf(address(staking)), usdcOwed, "staking short of USDC");
        assertGe(neuriio.balanceOf(address(staking)), neuOwed, "staking short of $NEURIIO");
        assertLe(neuriio.totalSupply(), neuriio.MAX_SUPPLY());
    }

    /// A fixed walk through the handler reaches every state the invariants talk about (so they aren't vacuous).
    function test_Audit_handlerReachesEveryState() public {
        handler.launch(1);
        handler.launchFtf(2);
        handler.buy(0, 0, 3 * 7_000e6, false); // graduates token 0 (a multiple of 3: the big-buy branch)
        handler.buy(1, 1, 1_000e6 + 1, true); // the FTF stays on its curve
        handler.sell(1, 1, 50, true);
        handler.stake(0, 0, 50);
        handler.buy(2, 0, 2_000e6 + 1, false); // pool buy
        handler.sell(0, 0, 10, false); // pool sell
        handler.donateToVault(3, 5_000e6);
        handler.buy(3, 1, 500e6 + 1, false); // a curve buy credits the donation to the FTF
        handler.warp(2 hours);
        handler.claim(0);
        handler.unstake(0, 6, 50); // $NEURIIO
        handler.creatorClaim(0);
        handler.payProtocol();
        handler.sellEverythingBack(1);
        assertEq(handler.graduations(), 1);
        assertGt(handler.curveTrades(), 2);
        assertGe(handler.poolTrades(), 2);
        assertEq(handler.stakes(), 1);
        assertEq(handler.rewardClaims(), 1);
        assertGt(neuriio.totalSupply(), 0);
        invariant_Audit_padSolvent();
        invariant_Audit_curveReserves();
        invariant_Audit_feesHeld();
        invariant_Audit_feesAddUp();
        invariant_Audit_stakingSolvent();
        invariant_Audit_noUnexpectedRevert();
    }

    /// The handler really exercised the system (not a vacuous pass).
    /// forge-config: default.invariant.runs = 256
    /// forge-config: default.invariant.depth = 100
    function invariant_Audit_noUnexpectedRevert() public view {
        assertEq(handler.unexpected(), bytes(""), "a call that should work reverted");
        assertLe(handler.tokensLength(), 6);
    }
}
