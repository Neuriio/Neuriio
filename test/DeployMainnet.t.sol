// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {NeuriioPad} from "../src/launch/NeuriioPad.sol";
import {NeuriioMinter} from "../src/stake/NeuriioMinter.sol";
import {NeuriioPlatformToken} from "../src/stake/NeuriioPlatformToken.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {DeployMainnet} from "../script/DeployMainnet.s.sol";

/// Stands in for the Safe: a contract that makes whatever call its signers agreed on.
contract MockSafe {
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

/// The mainnet deploy script, run for real on a local chain (TestUSDC posing as the bridged USDC): everything wired,
/// locked and owned by the timelock, the Safe able to pause at once and nothing else without the delay, the deployer
/// powerless, a full launch -> graduation -> pool trade -> payout working, and bad settings refused.
contract DeployMainnetTest is Test {
    uint256 constant DELAY = 2 days;
    uint256 constant VQ = 5_000e6;
    uint256 signerPk = 0xA11CE;

    DeployMainnet script;
    DeployMainnet.Deployment d;
    TestUSDC usdc;
    MockSafe safe;
    address deployer = DEFAULT_SENDER; // who broadcasts the script here
    address treasury = makeAddr("treasury");
    address buyback = makeAddr("buyback");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vm.chainId(4_242);
        // a real clock: the timelock marks done operations with timestamp 1, the local chain's starting time
        vm.warp(1_760_000_000);
        usdc = new TestUSDC(address(this));
        usdc.setMinter(address(this), true);
        safe = new MockSafe();
        script = new DeployMainnet();
        _env();
        d = script.run(); // also runs script.check(), which reverts on anything off
    }

    function _env() internal {
        vm.setEnv("USDC", vm.toString(address(usdc)));
        vm.setEnv("SAFE", vm.toString(address(safe)));
        vm.setEnv("TREASURY_WALLET", vm.toString(treasury));
        vm.setEnv("BUYBACK_WALLET", vm.toString(buyback));
        vm.setEnv("LAUNCH_SIGNER", vm.toString(vm.addr(signerPk)));
        vm.setEnv("VIRTUAL_QUOTE", vm.toString(VQ));
        vm.setEnv("TIMELOCK_DELAY", vm.toString(DELAY));
        vm.setEnv("RESERVED_TICKERS", "PUMP,FOMO");
        vm.setEnv("ALLOW_TESTNET", "false");
    }

    // ------------------------------------------------------------------ the deployed state

    function test_everythingLockedAndOwnedByTheTimelock() public view {
        address tl = address(d.timelock);
        assertEq(d.registry.owner(), tl);
        assertEq(d.pad.owner(), tl);
        assertEq(d.vault.owner(), tl);
        assertEq(d.minter.owner(), tl);
        assertEq(d.neuriio.owner(), tl);
        assertEq(d.factory.feeToSetter(), tl);
        assertEq(d.pad.guardian(), address(safe));
        assertEq(d.timelock.getMinDelay(), DELAY);
        assertTrue(d.minter.vaultsLocked() && d.minter.mintCurveFrozen() && d.neuriio.minterLocked());
        assertTrue(d.registry.reservedTicker(keccak256("PUMP")) && d.registry.reservedTicker(keccak256("USDC")));
    }

    /// The deployer keeps no power anywhere.
    function test_deployerIsPowerless() public {
        vm.startPrank(deployer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer));
        d.pad.setFee(50);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer));
        d.registry.setLaunchpad(deployer, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer));
        d.vault.setWallets(deployer, deployer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer));
        d.minter.setVault(deployer, false);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, deployer));
        d.neuriio.enableTransfers();
        vm.expectRevert(NeuriioPad.NotOwnerOrGuardian.selector);
        d.pad.pause();
        vm.expectRevert(bytes("UniswapV2: FORBIDDEN"));
        d.factory.setFeeVault(deployer);
        bytes32 proposer = d.timelock.PROPOSER_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, deployer, proposer)
        );
        d.timelock.schedule(address(d.pad), 0, abi.encodeCall(NeuriioPad.setFee, (50)), bytes32(0), 0, DELAY);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ the Safe: pause at once, the rest waits

    function test_safePausesAtOnceUnpauseWaitsForTheDelay() public {
        safe.exec(address(d.pad), abi.encodeCall(NeuriioPad.pause, ()));
        assertTrue(d.pad.paused());
        // the Safe isn't the owner: unpausing goes through the timelock
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(safe)));
        safe.exec(address(d.pad), abi.encodeCall(NeuriioPad.unpause, ()));
        bytes memory call = abi.encodeCall(NeuriioPad.unpause, ());
        _schedule(address(d.pad), call);
        vm.expectRevert(); // too early
        _execute(address(d.pad), call);
        vm.warp(block.timestamp + DELAY);
        _execute(address(d.pad), call);
        assertFalse(d.pad.paused());
    }

    function test_adminChangesWaitForTheDelay() public {
        bytes memory call = abi.encodeCall(NeuriioPad.setFee, (50));
        _schedule(address(d.pad), call);
        vm.warp(block.timestamp + DELAY - 1);
        vm.expectRevert();
        _execute(address(d.pad), call);
        vm.warp(block.timestamp + 1);
        _execute(address(d.pad), call);
        assertEq(d.pad.feeBps(), 50);
    }

    /// The locks hold even for the timelock: no new minting vault, no curve change, no new $NEURIIO minter.
    function test_locksHoldEvenForTheTimelock() public {
        bytes memory addVault = abi.encodeCall(NeuriioMinter.setVault, (alice, true));
        bytes memory curve = abi.encodeCall(NeuriioMinter.setMintCurve, (1e18, 0, 0));
        bytes memory newMinter = abi.encodeCall(NeuriioPlatformToken.setMinter, (alice));
        _schedule(address(d.minter), addVault);
        _schedule(address(d.minter), curve);
        _schedule(address(d.neuriio), newMinter);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(NeuriioMinter.VaultsAreLocked.selector);
        _execute(address(d.minter), addVault);
        vm.expectRevert(NeuriioMinter.MintCurveIsFrozen.selector);
        _execute(address(d.minter), curve);
        vm.expectRevert(NeuriioPlatformToken.MinterIsLocked.selector);
        _execute(address(d.neuriio), newMinter);
    }

    // ------------------------------------------------------------------ the stack works

    /// Launch -> curve buy that graduates -> pool sell (1% of the sale in USDC) -> the protocol share paid out.
    function test_launchGraduateTradeAndPayOut() public {
        usdc.mint(alice, 100_000e6);
        NeuriioPad.LaunchPass memory p = NeuriioPad.LaunchPass({
            creator: alice,
            xUserId: 42,
            handle: "alice",
            category: uint8(NeuriioPad.Category.Trader),
            profileHash: keccak256("profile"),
            deadline: block.timestamp + 1 hours
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, d.pad.hashLaunchPass(p));
        vm.startPrank(alice);
        usdc.approve(address(d.pad), type(uint256).max);
        address token = d.pad.launch(p, abi.encodePacked(r, s, v), 20_000e6, 0); // the first buy graduates it
        (, bool graduated,,,,) = d.pad.curves(token);
        assertTrue(graduated);
        uint256 tokens = IERC20(token).balanceOf(alice) / 10;
        IERC20(token).approve(address(d.router), tokens);
        uint256 feesBefore = d.vault.totalFees();
        uint256 back = d.router.sell(token, tokens, 0, block.timestamp);
        vm.stopPrank();
        assertEq(d.vault.totalFees() - feesBefore, (back + 98) / 99, "pool sell: 1% of the sale");

        d.vault.payProtocol(); // anyone
        assertGt(usdc.balanceOf(treasury), 0);
        assertGt(usdc.balanceOf(buyback), 0);
    }

    // ------------------------------------------------------------------ refused settings

    function test_refusesTestnetLikeSettings() public {
        vm.chainId(99_801);
        vm.expectRevert(bytes("testnet: set ALLOW_TESTNET"));
        script.params();
        vm.chainId(4_242);

        vm.setEnv("LAUNCH_SIGNER", "0x25626586434fb2003d12957a1fC4B0fA5EA52886");
        vm.expectRevert(bytes("LAUNCH_SIGNER: use a new key"));
        script.params();
        _env();

        vm.setEnv("SAFE", vm.toString(bob)); // a wallet, not a multisig
        vm.expectRevert(bytes("SAFE: not a deployed multisig"));
        script.params();
        _env();

        vm.setEnv("TIMELOCK_DELAY", vm.toString(uint256(1 hours)));
        vm.expectRevert(bytes("TIMELOCK_DELAY: at least 1 day"));
        script.params();
        _env();

        // a testnet rehearsal may use minutes (to see a timelocked change through), never less than 5
        vm.chainId(99_801);
        vm.setEnv("ALLOW_TESTNET", "true");
        vm.setEnv("TIMELOCK_DELAY", vm.toString(uint256(10 minutes)));
        script.params();
        vm.setEnv("TIMELOCK_DELAY", vm.toString(uint256(1 minutes)));
        vm.expectRevert(bytes("TIMELOCK_DELAY: at least 5 minutes"));
        script.params();
        vm.chainId(4_242);
        _env();

        vm.setEnv("USDC", vm.toString(address(d.neuriio))); // 18 decimals
        vm.expectRevert(bytes("USDC: not a 6-decimal token"));
        script.params();
    }

    // ------------------------------------------------------------------ helpers: the Safe runs the timelock

    function _schedule(address target, bytes memory data) internal {
        safe.exec(
            address(d.timelock),
            abi.encodeCall(TimelockController.schedule, (target, 0, data, bytes32(0), keccak256(data), DELAY))
        );
    }

    function _execute(address target, bytes memory data) internal {
        safe.exec(
            address(d.timelock),
            abi.encodeCall(TimelockController.execute, (target, 0, data, bytes32(0), keccak256(data)))
        );
    }
}
