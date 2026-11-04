// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAscendAdapter} from "../src/launch/IAscendAdapter.sol";
import {NeuriioLauncher} from "../src/launch/NeuriioLauncher.sol";
import {DeployAscend} from "../script/DeployAscend.s.sol";
import {AuditAdapter, AuditToken} from "./audit-ascend/AscendAuditBase.sol";

/// Stands in for the Safe: a contract that makes whatever call its signers agreed on.
contract AscendMockSafe {
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

/// Cantina risks 8 and 9 (governance, pause): the deploy script's result on a local chain. The timelock owns the launcher from its
/// first block, the deployer has no power at any point, the Safe can pause at once and do nothing else without the delay, and
/// a pause or a removed adapter never touches staking or tokens already launched.
contract DeployAscendTest is Test {
    uint256 constant DELAY = 2 days;
    uint256 signerPk = 0xA11CE;

    DeployAscend script;
    DeployAscend.Deployment d;
    DeployAscend.Params p;
    AuditToken usdc;
    AscendMockSafe safe;
    address deployer = makeAddr("deployer");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    uint256 salt;

    function setUp() public {
        vm.chainId(4_242);
        vm.warp(1_760_000_000); // a real clock: the timelock marks done operations with timestamp 1
        usdc = new AuditToken(6);
        safe = new AscendMockSafe();
        script = new DeployAscend();
        p = DeployAscend.Params(address(usdc), address(safe), vm.addr(signerPk), DELAY);
        script.validate(p, false);
        vm.prank(deployer);
        d = script.deploy(p);
        script.check(d, p, deployer);
    }

    function _schedule(address target, bytes memory data) internal {
        safe.exec(
            address(d.timelock),
            abi.encodeCall(TimelockController.schedule, (target, 0, data, 0, bytes32(++salt), DELAY))
        );
    }

    function _execute(address target, bytes memory data) internal {
        safe.exec(address(d.timelock), abi.encodeCall(TimelockController.execute, (target, 0, data, 0, bytes32(salt))));
    }

    function _viaTimelock(address target, bytes memory data) internal {
        _schedule(target, data);
        skip(DELAY);
        _execute(target, data);
    }

    function _launch(address who, uint64 xId, string memory handle) internal returns (address) {
        NeuriioLauncher.LaunchPass memory pass =
            NeuriioLauncher.LaunchPass(who, xId, handle, 0, bytes32(0), "", block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, d.launcher.hashLaunchPass(pass));
        vm.prank(who);
        return d.launcher.launch(pass, abi.encodePacked(r, s, v), 0, 0);
    }

    function _plugInAdapter() internal returns (AuditAdapter adapter) {
        adapter = new AuditAdapter(usdc);
        _viaTimelock(address(d.launcher), abi.encodeCall(NeuriioLauncher.setAdapter, (adapter)));
    }

    // ------------------------------------------------------------------ the deployed state

    function test_ownedByTheTimelockFromTheStart() public view {
        assertEq(d.launcher.owner(), address(d.timelock));
        assertEq(d.launcher.pendingOwner(), address(0));
        assertEq(d.launcher.guardian(), address(safe));
        assertEq(address(d.launcher.adapter()), address(0));
        assertEq(address(d.staking.launcher()), address(d.launcher));
        assertEq(d.timelock.getMinDelay(), DELAY);
    }

    /// The owner is the timelock from the constructor on: its only ownership event goes from nobody straight to the timelock.
    function test_noOwnershipEverPassedThroughTheDeployer() public {
        vm.recordLogs();
        vm.prank(deployer);
        DeployAscend.Deployment memory fresh = script.deploy(p);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(fresh.launcher) && logs[i].topics[0] == Ownable.OwnershipTransferred.selector
            ) {
                seen++;
                assertEq(logs[i].topics[1], bytes32(0));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(address(fresh.timelock)))));
            }
        }
        assertEq(seen, 1);
    }

    function test_deployerIsPowerless() public {
        address[2] memory who = [deployer, address(script)];
        for (uint256 i; i < 2; ++i) {
            vm.startPrank(who[i]);
            bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, who[i]);
            vm.expectRevert(err);
            d.launcher.setAdapter(IAscendAdapter(address(1)));
            vm.expectRevert(err);
            d.launcher.setLaunchSigner(who[i]);
            vm.expectRevert(err);
            d.launcher.setGuardian(who[i]);
            vm.expectRevert(err);
            d.launcher.setReservedTickers(new string[](0), true);
            vm.expectRevert(err);
            d.launcher.unpause();
            vm.expectRevert(err);
            d.launcher.transferOwnership(who[i]);
            vm.expectRevert(err);
            d.launcher.renounceOwnership();
            vm.expectRevert(NeuriioLauncher.NotOwnerOrGuardian.selector);
            d.launcher.pause();
            vm.stopPrank();
            bytes32 proposer = d.timelock.PROPOSER_ROLE();
            assertFalse(d.timelock.hasRole(proposer, who[i]));
            assertFalse(d.timelock.hasRole(d.timelock.EXECUTOR_ROLE(), who[i]));
            assertFalse(d.timelock.hasRole(d.timelock.CANCELLER_ROLE(), who[i]));
            assertFalse(d.timelock.hasRole(d.timelock.DEFAULT_ADMIN_ROLE(), who[i]));
        }
    }

    // ------------------------------------------------------------------ the Safe, as guardian and through the timelock

    function test_safeCanPauseAtOnceAndNothingElseDirectly() public {
        bytes[6] memory calls = [
            abi.encodeCall(NeuriioLauncher.setAdapter, (IAscendAdapter(address(1)))),
            abi.encodeCall(NeuriioLauncher.setLaunchSigner, (address(1))),
            abi.encodeCall(NeuriioLauncher.setGuardian, (address(1))),
            abi.encodeCall(NeuriioLauncher.unpause, ()),
            abi.encodeCall(Ownable.transferOwnership, (address(1))),
            abi.encodeCall(Ownable.renounceOwnership, ())
        ];
        for (uint256 i; i < calls.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(safe)));
            safe.exec(address(d.launcher), calls[i]);
        }
        safe.exec(address(d.launcher), abi.encodeCall(NeuriioLauncher.pause, ()));
        assertTrue(d.launcher.paused());
    }

    function test_ownerChangesWaitForTheDelay() public {
        AuditAdapter adapter = new AuditAdapter(usdc);
        bytes memory data = abi.encodeCall(NeuriioLauncher.setAdapter, (adapter));
        _schedule(address(d.launcher), data);
        skip(DELAY - 1);
        vm.expectRevert();
        _execute(address(d.launcher), data);
        assertEq(address(d.launcher.adapter()), address(0));
        skip(1);
        _execute(address(d.launcher), data);
        assertEq(address(d.launcher.adapter()), address(adapter));
    }

    function test_onlyTheSafeCanRunTheTimelock() public {
        bytes memory data = abi.encodeCall(NeuriioLauncher.setAdapter, (IAscendAdapter(address(1))));
        bytes32 role = d.timelock.PROPOSER_ROLE();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, role));
        d.timelock.schedule(address(d.launcher), 0, data, 0, 0, DELAY);
    }

    function test_safeCanCancelABadChange() public {
        bytes memory data = abi.encodeCall(NeuriioLauncher.setAdapter, (IAscendAdapter(address(1))));
        _schedule(address(d.launcher), data);
        bytes32 id = d.timelock.hashOperation(address(d.launcher), 0, data, 0, bytes32(salt));
        safe.exec(address(d.timelock), abi.encodeCall(TimelockController.cancel, (id)));
        skip(DELAY);
        vm.expectRevert();
        _execute(address(d.launcher), data);
    }

    function test_noLaunchesUntilAnAdapterIsPluggedIn() public {
        NeuriioLauncher.LaunchPass memory pass =
            NeuriioLauncher.LaunchPass(alice, 1, "alice", 0, bytes32(0), "", block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, d.launcher.hashLaunchPass(pass));
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.NoAdapter.selector);
        d.launcher.launch(pass, abi.encodePacked(r, s, v), 0, 0);
        _plugInAdapter();
        address token = _launch(alice, 1, "alice");
        assertTrue(d.staking.isStakeable(token));
    }

    function test_twoStepOwnershipThroughTheTimelock() public {
        _viaTimelock(address(d.launcher), abi.encodeCall(Ownable.transferOwnership, (bob)));
        assertEq(d.launcher.owner(), address(d.timelock)); // not until bob accepts
        assertEq(d.launcher.pendingOwner(), bob);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        d.launcher.acceptOwnership();
        vm.prank(bob);
        d.launcher.acceptOwnership();
        assertEq(d.launcher.owner(), bob);
    }

    // ------------------------------------------------------------------ pause and adapter changes reach only launches

    function test_pauseStopsLaunchesAndNothingElse() public {
        _plugInAdapter();
        address token = _launch(alice, 1, "alice");
        AuditToken(token).mint(bob, 1e18);
        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(d.staking), type(uint256).max);
        vm.startPrank(bob);
        AuditToken(token).approve(address(d.staking), type(uint256).max);
        d.staking.stake(token, 5e17);
        vm.stopPrank();

        safe.exec(address(d.launcher), abi.encodeCall(NeuriioLauncher.pause, ()));

        NeuriioLauncher.LaunchPass memory pass =
            NeuriioLauncher.LaunchPass(bob, 2, "bob", 0, bytes32(0), "", block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, d.launcher.hashLaunchPass(pass));
        vm.prank(bob);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        d.launcher.launch(pass, abi.encodePacked(r, s, v), 0, 0);

        assertTrue(d.staking.isStakeable(token));
        d.staking.notifyReward(token, 1_000e6);
        skip(1 hours);
        vm.startPrank(bob);
        d.staking.stake(token, 5e17);
        d.staking.unstake(token, 1e18);
        address[] memory list = new address[](1);
        list[0] = token;
        assertGt(d.staking.claim(list, bob), 0);
        vm.stopPrank();
        assertEq(AuditToken(token).balanceOf(bob), 1e18);

        _viaTimelock(address(d.launcher), abi.encodeCall(NeuriioLauncher.unpause, ()));
        assertFalse(d.launcher.paused());
    }

    function test_removingTheAdapterOnlyStopsNewLaunches() public {
        _plugInAdapter();
        address token = _launch(alice, 1, "alice");
        _viaTimelock(address(d.launcher), abi.encodeCall(NeuriioLauncher.setAdapter, (IAscendAdapter(address(0)))));
        assertTrue(d.staking.isStakeable(token));
        assertEq(d.launcher.creatorOf(token), alice);
    }

    /// FINDING I-04: the owner can renounce, as with any Ownable contract. It would take the Safe and the full delay, and would
    /// freeze the launcher's settings for good (a pause could never be lifted), but staking and launched tokens carry on.
    function test_I04_renouncingFreezesTheLauncherOnly() public {
        _plugInAdapter();
        address token = _launch(alice, 1, "alice");
        _viaTimelock(address(d.launcher), abi.encodeCall(Ownable.renounceOwnership, ()));
        assertEq(d.launcher.owner(), address(0));
        safe.exec(address(d.launcher), abi.encodeCall(NeuriioLauncher.pause, ())); // the guardian still can
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(safe)));
        safe.exec(address(d.launcher), abi.encodeCall(NeuriioLauncher.unpause, ()));
        assertTrue(d.staking.isStakeable(token));
    }

    // ------------------------------------------------------------------ bad settings

    function test_badSettingsRefused() public {
        DeployAscend.Params memory q = p;
        q.usdc = address(new AuditToken(18));
        vm.expectRevert("USDC: not a 6-decimal token");
        script.validate(q, false);
        q = p;
        q.usdc = alice;
        vm.expectRevert("USDC: not a 6-decimal token");
        script.validate(q, false);
        q = p;
        q.safe = alice;
        vm.expectRevert("SAFE: not a deployed multisig");
        script.validate(q, false);
        q = p;
        q.launchSigner = address(0);
        vm.expectRevert("LAUNCH_SIGNER: use a new key");
        script.validate(q, false);
        q = p;
        q.launchSigner = 0x25626586434fb2003d12957a1fC4B0fA5EA52886;
        vm.expectRevert("LAUNCH_SIGNER: use a new key");
        script.validate(q, false);
        q = p;
        q.timelockDelay = 1 days - 1;
        vm.expectRevert("TIMELOCK_DELAY: too short");
        script.validate(q, false);
    }

    function test_testnetNeedsTheFlag() public {
        vm.chainId(99_801);
        vm.expectRevert("testnet: set ALLOW_TESTNET");
        script.validate(p, false);
        DeployAscend.Params memory q = p;
        q.timelockDelay = 5 minutes;
        script.validate(q, true);
    }

    function test_checkCatchesAWrongDeployment() public {
        DeployAscend.Params memory q = p;
        q.launchSigner = alice;
        vm.expectRevert("launcher: signer");
        script.check(d, q, deployer);
    }
}
