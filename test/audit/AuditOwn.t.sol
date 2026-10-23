// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {NeuriioPad, ICurveFeeVault} from "../../src/launch/NeuriioPad.sol";
import {NeuriioFees} from "../../src/launch/NeuriioFees.sol";
import {NeuriioRegistry} from "../../src/launch/NeuriioRegistry.sol";
import {NeuriioRouter} from "../../src/swap/NeuriioRouter.sol";
import {NeuriioStaking} from "../../src/stake/NeuriioStaking.sol";
import {NeuriioMinter} from "../../src/stake/NeuriioMinter.sol";
import {NeuriioPlatformToken} from "../../src/stake/NeuriioPlatformToken.sol";
import {ISwapFactory, ISwapFactoryAdmin} from "../../src/swap/interfaces.sol";
import {NeuriioBase} from "../Base.t.sol";

interface IAuditV2FactoryOwner {
    function setFeeToSetter(address feeToSetter) external;
}

/// Stands in for the 2-of-3 Safe: makes whatever call its signers agreed on.
contract AuditMockSafe {
    function exec(address to, bytes calldata data) external returns (bytes memory ret) {
        bool ok;
        (ok, ret) = to.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/// A fee vault that refuses every fee (what a broken, malicious or blacklisted vault looks like to the pad and pairs).
contract AuditRevertingVault {
    function notifyCurveFee(address, uint256) external pure {
        revert("vault down");
    }

    function notifyPoolFee(address, uint256) external pure {
        revert("vault down");
    }
}

/// The NeuriioBase stack put into script/DeployMainnet.s.sol's configuration: locks on, the Safe as guardian, and every
/// owner power (registry, pad, fees, minter, $NEURIIO, the factory's feeToSetter) behind a 48 h timelock the Safe runs.
abstract contract AuditMainnetBase is NeuriioBase {
    uint256 constant DELAY = 48 hours;
    TimelockController timelock;
    AuditMockSafe safe;
    address buyback = makeAddr("buyback");
    uint256 saltNonce;

    function _mainnetConfig() internal {
        vm.warp(1_760_000_000);
        safe = new AuditMockSafe();
        address[] memory onlySafe = new address[](1);
        onlySafe[0] = address(safe);
        timelock = new TimelockController(DELAY, onlySafe, onlySafe, address(0));
        address[5] memory owned = [address(registry), address(pad), address(vault), address(minter), address(neuriio)];
        vm.startPrank(owner);
        vault.setWallets(treasury, buyback);
        pad.setGuardian(address(safe));
        minter.lockVaults();
        minter.freezeMintCurve();
        neuriio.lockMinter();
        for (uint256 i; i < owned.length; ++i) {
            Ownable2Step(owned[i]).transferOwnership(address(timelock));
        }
        IAuditV2FactoryOwner(address(factory)).setFeeToSetter(address(timelock));
        vm.stopPrank();
        for (uint256 i; i < owned.length; ++i) {
            _timelocked(owned[i], abi.encodeCall(Ownable2Step.acceptOwnership, ()));
        }
        assertEq(pad.owner(), address(timelock));
    }

    function _schedule(address target, bytes memory data) internal returns (bytes32 salt) {
        salt = bytes32(++saltNonce);
        safe.exec(
            address(timelock), abi.encodeCall(TimelockController.schedule, (target, 0, data, bytes32(0), salt, DELAY))
        );
    }

    function _execute(address target, bytes memory data, bytes32 salt) internal {
        safe.exec(address(timelock), abi.encodeCall(TimelockController.execute, (target, 0, data, bytes32(0), salt)));
    }

    /// Schedules `data` on `target`, waits out the delay and executes it.
    function _timelocked(address target, bytes memory data) internal {
        bytes32 salt = _schedule(target, data);
        vm.warp(block.timestamp + DELAY);
        _execute(target, data, salt);
    }

    function _signFor(NeuriioPad p, NeuriioPad.LaunchPass memory pass, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, p.hashLaunchPass(pass));
        return abi.encodePacked(r, s, v);
    }
}

contract AuditOwnTest is AuditMainnetBase {
    // ------------------------------------------------------------------ launch signer

    /// A leaked `launchSigner` key (a hot key the backend holds) launches any X identity to the attacker's wallets in
    /// one block. The Safe's only instant lever is `pause()`, which also stops every buy and graduation; rotating the
    /// signer waits 48 h; and the squatted identities can never be freed, on any NeuriioPad version.
    function test_leakedSignerSquatsIdentitiesForever() public {
        _mainnetConfig();
        address honest = _launch(); // an honest token already trading
        _tradeBuy(alice, honest, 100e6);

        // 1. one block, 25 famous X accounts, each launched to a wallet the attacker controls
        address[] memory squatted = new address[](25);
        for (uint256 i; i < 25; ++i) {
            address w = address(uint160(0xA77AC000 + i));
            NeuriioPad.LaunchPass memory p = _pass(w, uint64(1 + i), string.concat("famous", vm.toString(i)));
            bytes memory sig = _sign(p, signerPk);
            vm.prank(w);
            squatted[i] = pad.launch(p, sig, 0, 0);
        }

        // 2. the Safe pauses at once: launches stop, and so does every buy on every curve
        safe.exec(address(pad), abi.encodeCall(NeuriioPad.pause, ()));
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        trade.buy(honest, 100e6, 0, block.timestamp);

        // 3. a new signer only after the 48 h delay
        uint256 newPk = 0xB0B;
        bytes memory rotate = abi.encodeCall(NeuriioPad.setLaunchSigner, (vm.addr(newPk)));
        bytes32 salt = _schedule(address(pad), rotate);
        vm.expectRevert();
        _execute(address(pad), rotate, salt);
        vm.warp(block.timestamp + DELAY);
        _execute(address(pad), rotate, salt);

        // 4. even with the new key on a brand-new pad version, the real account can never launch
        NeuriioPad pad2 = new NeuriioPad(
            address(timelock),
            ISwapFactory(address(factory)),
            IERC20(address(usdc)),
            VQ,
            100,
            vm.addr(newPk),
            ICurveFeeVault(address(vault)),
            registry
        );
        _timelocked(address(registry), abi.encodeCall(NeuriioRegistry.setLaunchpad, (address(pad2), true)));
        address real = makeAddr("the real famous0");
        NeuriioPad.LaunchPass memory realPass = _pass(real, 1, "famous0");
        bytes memory realSig = _signFor(pad2, realPass, newPk);
        vm.prank(real);
        vm.expectRevert(NeuriioRegistry.AlreadyLaunched.selector);
        pad2.launch(realPass, realSig, 0, 0);
        // not even under another handle: the X account itself is used up
        realPass.handle = "famous0_real";
        realSig = _signFor(pad2, realPass, newPk);
        vm.prank(real);
        vm.expectRevert(NeuriioRegistry.AlreadyLaunched.selector);
        pad2.launch(realPass, realSig, 0, 0);
        assertEq(registry.tokenOfXUser(1), squatted[0]);
        assertEq(registry.creatorsOf(squatted[0])[0], address(uint160(0xA77AC000)));
    }

    // ------------------------------------------------------------------ "sells always stay open"

    /// After the 48 h delay, the timelock can point the curve's and the pools' fees at a vault that reverts: every
    /// curve sell and every pool swap then reverts, so the curves' USDC and the graduated tokens are stuck. (The same
    /// happens at once, with no delay, if the USDC issuer blacklists NeuriioFees: see AuditFiatUsdcTest.)
    function test_revertingFeeVaultFreezesCurveSellsAndPoolSwaps() public {
        _mainnetConfig();
        address onCurve = _launch();
        uint256 held = _buy(alice, onCurve, 1_000e6);
        address graduated = _graduated(bob);
        uint256 bobTokens = IERC20(graduated).balanceOf(bob);

        AuditRevertingVault bad = new AuditRevertingVault();
        _timelocked(address(pad), abi.encodeCall(NeuriioPad.setFeeVault, (ICurveFeeVault(address(bad)))));
        _timelocked(address(factory), abi.encodeCall(ISwapFactoryAdmin.setFeeVault, (address(bad))));

        vm.startPrank(alice);
        IERC20(onCurve).approve(address(pad), held);
        vm.expectRevert(bytes("vault down"));
        pad.sell(onCurve, held, 0, block.timestamp);
        vm.stopPrank();

        vm.startPrank(bob);
        IERC20(graduated).approve(address(trade), bobTokens);
        vm.expectRevert(bytes("vault down"));
        trade.sell(graduated, bobTokens / 10, 0, block.timestamp);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ the minter's locks

    /// `lockVaults()` fixes the minting vaults for good, but `setFeeVault` on the pad and the factory stays open: any
    /// later NeuriioFees (a fix or a new split) receives fees and pays stakers USDC, yet mints no $NEURIIO, ever.
    function test_afterLockVaultsAReplacementVaultNeverMints() public {
        _mainnetConfig();
        NeuriioFees v2 = new NeuriioFees(
            address(timelock), IERC20(address(usdc)), ISwapFactory(address(factory)), registry, staking, minter
        );
        bytes memory approveV2 = abi.encodeCall(NeuriioMinter.setVault, (address(v2), true));
        bytes32 salt = _schedule(address(minter), approveV2);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(NeuriioMinter.VaultsAreLocked.selector);
        _execute(address(minter), approveV2, salt);
        _timelocked(address(pad), abi.encodeCall(NeuriioPad.setFeeVault, (ICurveFeeVault(address(v2)))));
        _timelocked(address(factory), abi.encodeCall(ISwapFactoryAdmin.setFeeVault, (address(v2))));

        address token = _graduated(alice);
        _stake(alice, token, IERC20(token).balanceOf(alice));
        _tradeBuy(bob, token, 10_000e6);
        vm.warp(block.timestamp + 1 hours);
        (uint256 usdcEarned, uint256 neuEarned) = staking.earned(alice, token);
        assertGt(usdcEarned, 0);
        assertEq(neuEarned, 0, "no $NEURIIO from a vault added after the lock");
    }

    // ------------------------------------------------------------------ $NEURIIO mint farming (accepted risk)

    /// USDC sent straight to NeuriioFees is nobody's fee: the next trade credits only its own fee, nothing is minted on
    /// the donation, and anyone can sweep it to the treasury.
    function test_donationsMintNothingAndGoToTheTreasury() public {
        vm.prank(owner);
        minter.setMintCurve(10e18, FLAT_UNTIL, DECAY_SCALE); // the launch rate
        _mainnetConfig();
        address token = _graduated(alice);
        _stake(alice, token, IERC20(token).balanceOf(alice));
        uint256 feesBefore = vault.totalFees();
        vm.prank(bob);
        usdc.transfer(address(vault), 900_000e6);
        _tradeBuy(bob, token, 100e6); // its own 1% fee: 1 USDC
        assertEq(vault.totalFees() - feesBefore, 1e6, "only the trade's fee counts");
        vm.warp(block.timestamp + 1 hours);
        (, uint256 neu) = staking.earned(alice, token);
        assertApproxEqAbs(neu, 4e18, 1e15, "4 $NEURIIO for the trade's $1 fee (10 per $1 x 40%), none for the donation");
        uint256 t = usdc.balanceOf(treasury);
        vm.prank(bob);
        vault.sweep();
        assertEq(usdc.balanceOf(treasury) - t, 900_000e6);
    }

    /// What farming still costs at launch (mint rate 10 per $1, the deploy default): a whale graduates their own token,
    /// stakes it and trades back and forth in its pool. A first small round costs half its fees (nobody stakes $NEURIIO
    /// yet); once the whale's $NEURIIO is staked, only the 10% treasury share leaves them: ~2.5 cents per $NEURIIO.
    function test_washTradingCostPerNeuriio() public {
        vm.prank(owner);
        minter.setMintCurve(10e18, FLAT_UNTIL, DECAY_SCALE);
        _mainnetConfig();
        address whale = makeAddr("whale");
        _fund(whale, 3_000_000e6);
        address token = _launchAs(whale, 9_999, "whale", 20_000e6); // the first buy sells out the curve
        assertTrue(_curve(token).graduated);
        _stake(whale, token, IERC20(token).balanceOf(whale) / 2);
        vm.prank(whale);
        IERC20(token).approve(address(trade), type(uint256).max);
        address[] memory both = new address[](2);
        (both[0], both[1]) = (token, address(neuriio));

        (uint256 cost1, uint256 fees1) = _washRound(whale, token, both, 1, 50_000e6);
        uint256 neu1 = staking.stakedOf(whale, address(neuriio));
        (uint256 cost2, uint256 fees2) = _washRound(whale, token, both, 10, 500_000e6);
        uint256 neu2 = staking.stakedOf(whale, address(neuriio)) - neu1;

        emit log_named_decimal_uint("round 1: fees generated (USDC)", fees1, 6);
        emit log_named_decimal_uint("round 1: net cost (USDC)", cost1, 6);
        emit log_named_decimal_uint("round 1: $NEURIIO minted", neu1, 18);
        emit log_named_decimal_uint("round 2: fees generated (USDC)", fees2, 6);
        emit log_named_decimal_uint("round 2: net cost (USDC)", cost2, 6);
        emit log_named_decimal_uint("round 2: $NEURIIO minted", neu2, 18);
        assertApproxEqRel(cost1, fees1 / 2, 0.05e18); // plus the graduation fees still dripping
        assertApproxEqRel(cost2, fees2 / 10, 0.02e18);
        assertApproxEqRel(neu2, fees2 * 4e12, 0.01e18); // 4 $NEURIIO per $1 of fee
    }

    /// `rounds` round trips of `size` USDC in the whale's own pool, then an hour of drip, then every claim.
    function _washRound(address whale, address token, address[] memory claimFrom, uint256 rounds, uint256 size)
        internal
        returns (uint256 netCost, uint256 fees)
    {
        uint256 before = usdc.balanceOf(whale);
        uint256 feesBefore = vault.totalFees();
        for (uint256 i; i < rounds; ++i) {
            uint256 tokens = _tradeBuy(whale, token, size);
            vm.prank(whale);
            trade.sell(token, tokens, 0, block.timestamp);
        }
        fees = vault.totalFees() - feesBefore;
        vm.warp(block.timestamp + 1 hours);
        vm.startPrank(whale);
        staking.claim(claimFrom, whale);
        vault.claim(whale); // the creator share
        vm.stopPrank();
        netCost = before - usdc.balanceOf(whale);
    }

    // ------------------------------------------------------------------ tickers

    /// Personal tickers (the handle in caps) and FTF tickers live in separate namespaces, so an FTF can take the exact
    /// ticker of an existing personal token (and vice versa).
    function test_ftfTickerCanCopyAPersonalTicker() public {
        address personal = _launchAs(creator, 1, "alice", 0);
        address group = _launchFtf(_ftfPass("Not Alice", "ALICE"), 0);
        assertEq(IERC20Metadata(personal).symbol(), "ALICE");
        assertEq(IERC20Metadata(group).symbol(), "ALICE");
    }

    /// `setReservedTickers` hashes the string as given; tickers are compared in upper case, so reserving "pump" does
    /// nothing (DeployMainnet passes RESERVED_TICKERS through as typed).
    function test_reservingALowerCaseTickerDoesNothing() public {
        string[] memory t = new string[](1);
        t[0] = "pump";
        vm.prank(owner);
        registry.setReservedTickers(t, true);
        address token = _launchAs(creator, 1, "pump", 0);
        assertEq(IERC20Metadata(token).symbol(), "PUMP");
    }

    // ------------------------------------------------------------------ dust and drips

    /// The fee inside a gross buy rounds down, so a buy of up to 100 base units (0.0001 USDC) pays no fee.
    function test_tinyBuysPayNoFee() public {
        address token = _launch();
        uint256 feesBefore = vault.totalFees();
        vm.startPrank(alice);
        usdc.approve(address(pad), type(uint256).max);
        uint256 got;
        for (uint256 i; i < 10; ++i) {
            got += pad.buy(token, 100, 0, block.timestamp);
        }
        vm.stopPrank();
        assertGt(got, 0);
        assertEq(vault.totalFees(), feesBefore);
    }

    /// Anyone can `notifyReward` 1 base unit, which re-spreads what's still dripping over a fresh hour. Pinged every
    /// minute, a reward that should be fully paid after an hour is only ~64% paid; the rest keeps dripping later.
    function test_anyoneCanStretchADripWithOneBaseUnit() public {
        address token = _graduated(alice);
        _stake(alice, token, IERC20(token).balanceOf(alice));
        vm.warp(block.timestamp + 2 hours); // the graduation's own fees have finished dripping
        (uint256 base,) = staking.earned(alice, token);
        usdc.mint(address(this), 1_000e6 + 60);
        usdc.approve(address(staking), type(uint256).max);
        staking.notifyReward(token, 1_000e6);
        for (uint256 i; i < 60; ++i) {
            vm.warp(block.timestamp + 1 minutes);
            staking.notifyReward(token, 1);
        }
        (uint256 earnedNow,) = staking.earned(alice, token);
        uint256 paid = earnedNow - base;
        assertGt(paid, 630e6);
        assertLt(paid, 640e6); // (1 - (59/60)^60) of 1,000 USDC
    }
}

/// A USDC like Circle's FiatToken: blacklist (sender, recipient and caller, even for 0-value transfers) and pause.
contract AuditFiatUSDC is ERC20 {
    mapping(address => bool) public isBlacklisted;
    bool public paused;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function blacklist(address who, bool on) external {
        isBlacklisted[who] = on;
    }

    function setPaused(bool on) external {
        paused = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!paused, "Pausable: paused");
        require(!isBlacklisted[msg.sender] && !isBlacklisted[from] && !isBlacklisted[to], "Blacklistable: blacklisted");
        super._update(from, to, value);
    }
}

/// The stack on a FiatToken-like USDC: what the issuer's blacklist does to it.
contract AuditFiatUsdcTest is Test {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 constant SIGNER_PK = 0x5157;
    AuditFiatUSDC usdc;
    ISwapFactoryAdmin factory;
    NeuriioRegistry registry;
    NeuriioStaking staking;
    NeuriioMinter minter;
    NeuriioFees vault;
    NeuriioRouter router;
    NeuriioPad pad;
    address alice = makeAddr("alice");
    uint64 nextXId = 1;

    function setUp() public {
        usdc = new AuditFiatUSDC();
        registry = new NeuriioRegistry(address(this));
        factory = ISwapFactoryAdmin(
            deployCode("UniswapV2Factory.sol:UniswapV2Factory", abi.encode(address(this), address(usdc)))
        );
        factory.setRegistry(address(registry));
        staking = new NeuriioStaking(ISwapFactory(address(factory)), IERC20(address(usdc)), address(this));
        minter = new NeuriioMinter(address(this), staking, 25e18, 1_000_000e18, 120_000_000e18);
        staking.neuriio().setMinter(address(minter));
        vault = new NeuriioFees(
            address(this), IERC20(address(usdc)), ISwapFactory(address(factory)), registry, staking, minter
        );
        minter.setVault(address(vault), true);
        factory.setFeeVault(address(vault));
        router = new NeuriioRouter(registry, ISwapFactory(address(factory)));
        pad = new NeuriioPad(
            address(this),
            ISwapFactory(address(factory)),
            IERC20(address(usdc)),
            5_000e6,
            100,
            vm.addr(SIGNER_PK),
            ICurveFeeVault(address(vault)),
            registry
        );
        registry.setLaunchpad(address(pad), true);
        usdc.mint(alice, 1_000_000e6);
        vm.startPrank(alice);
        usdc.approve(address(router), type(uint256).max);
        usdc.approve(address(pad), type(uint256).max);
        vm.stopPrank();
    }

    function _launch() internal returns (address token) {
        address who = makeAddr(string.concat("creator", vm.toString(nextXId)));
        NeuriioPad.LaunchPass memory p = NeuriioPad.LaunchPass({
            creator: who,
            xUserId: nextXId,
            handle: string.concat("dog", vm.toString(nextXId)),
            category: 0,
            profileHash: bytes32(0),
            deadline: block.timestamp + 1 hours
        });
        nextXId++;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, pad.hashLaunchPass(p));
        vm.prank(who);
        token = pad.launch(p, abi.encodePacked(r, s, v), 0, 0);
    }

    /// Blacklisting NeuriioFees freezes every curve trade (sells included) and every pool swap at once, and freezes
    /// the creators' unclaimed fees. Only the timelock can route fees elsewhere (48 h).
    function test_blacklistedFeeVaultFreezesAllTrading() public {
        address onCurve = _launch();
        vm.prank(alice);
        uint256 held = pad.buy(onCurve, 1_000e6, 0, block.timestamp);
        address graduated = _launch();
        vm.prank(alice);
        router.buy(graduated, 20_000e6, 0, block.timestamp);
        vm.prank(alice);
        router.buy(graduated, 100e6, 0, block.timestamp); // pool fees for its creator

        usdc.blacklist(address(vault), true);

        vm.startPrank(alice);
        IERC20(onCurve).approve(address(pad), held);
        vm.expectRevert(bytes("Blacklistable: blacklisted"));
        pad.sell(onCurve, held, 0, block.timestamp);
        IERC20(graduated).approve(address(router), type(uint256).max);
        vm.expectRevert(bytes("UniswapV2: TRANSFER_FAILED")); // the pair's fee transfer to the vault
        router.sell(graduated, 1e18, 0, block.timestamp);
        vm.stopPrank();

        address graduatedCreator = registry.creatorsOf(graduated)[0];
        assertGt(vault.creatorBalance(graduatedCreator), 0);
        vm.prank(graduatedCreator);
        vm.expectRevert(bytes("Blacklistable: blacklisted"));
        vault.claim(graduatedCreator);
    }

    /// Graduation's `skim(DEAD)` sends USDC (0 of it) to 0x...dEaD: if the issuer ever blacklisted that address, every
    /// graduating buy would revert, on every curve of this pad (DEAD is a constant).
    function test_blacklistedDeadBlocksEveryGraduation() public {
        address token = _launch();
        usdc.blacklist(DEAD, true);
        vm.prank(alice);
        vm.expectRevert(bytes("UniswapV2: TRANSFER_FAILED")); // skim's 0-USDC transfer to DEAD
        pad.buy(token, 20_000e6, 0, block.timestamp);
        // buys that don't finish the curve still work
        vm.prank(alice);
        pad.buy(token, 1_000e6, 0, block.timestamp);
    }
}
