// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {NeuriioPad} from "../../src/launch/NeuriioPad.sol";
import {CreateSafe, ISafe} from "../../script/CreateSafe.s.sol";
import {SafeTx} from "../../script/SafeTx.s.sol";
import {DeployMainnet} from "../../script/DeployMainnet.s.sol";

/// The mainnet rehearsal on a FORK of Elysium testnet, against Safe's real v1.3.0 contracts there: create a 2-of-3 Safe,
/// run the mainnet deploy with it, pause at once with 2 approvals, then unpause through the timelock (scheduled, refused
/// early, executed after the delay). Network only on request:
///   FORK=true forge test --match-path test/fork/Rehearsal.t.sol -vv
contract RehearsalForkTest is Test {
    address constant TEST_USDC = 0xe83c3630CaB1c3d1d3B19A1F6eE393618C690C7b; // testnet's TestUSDC (6 decimals)
    uint256 constant DELAY = 10 minutes;

    address s1 = makeAddr("signer1");
    address s2 = makeAddr("signer2");
    address s3 = makeAddr("signer3");
    address safe;
    DeployMainnet.Deployment d;
    SafeTx safeTx;

    function setUp() public {
        if (!vm.envOr("FORK", false)) return;
        vm.createSelectFork("elysium_testnet");
        vm.setEnv("OWNERS", string.concat(vm.toString(s1), ",", vm.toString(s2), ",", vm.toString(s3)));
        vm.setEnv("THRESHOLD", "2");
        vm.setEnv("SALT_NONCE", vm.toString(uint256(keccak256("neuriio rehearsal"))));
        safe = new CreateSafe().run();

        vm.setEnv("USDC", vm.toString(TEST_USDC));
        vm.setEnv("SAFE", vm.toString(safe));
        vm.setEnv("TREASURY_WALLET", vm.toString(safe));
        vm.setEnv("BUYBACK_WALLET", vm.toString(safe));
        vm.setEnv("LAUNCH_SIGNER", vm.toString(makeAddr("rehearsal signer")));
        vm.setEnv("VIRTUAL_QUOTE", vm.toString(uint256(6_000e6)));
        vm.setEnv("TIMELOCK_DELAY", vm.toString(DELAY));
        vm.setEnv("ALLOW_TESTNET", "true");
        d = new DeployMainnet().run();
        safeTx = new SafeTx();
    }

    function test_rehearsal() public {
        if (!vm.envOr("FORK", false)) return;
        assertEq(ISafe(safe).getThreshold(), 2);
        assertEq(d.pad.guardian(), safe);
        assertEq(d.pad.owner(), address(d.timelock));

        // emergency pause: 2 of the 3 approve, anyone executes
        _safeCall(address(d.pad), abi.encodeCall(NeuriioPad.pause, ()), s1, s3);
        assertTrue(d.pad.paused());

        // unpause through the timelock: the Safe schedules it ...
        bytes memory unpause = abi.encodeCall(NeuriioPad.unpause, ());
        bytes32 salt = keccak256("rehearsal unpause");
        _safeCall(
            address(d.timelock),
            abi.encodeCall(TimelockController.schedule, (address(d.pad), 0, unpause, bytes32(0), salt, DELAY)),
            s2,
            s3
        );
        // ... it can't run before the delay ...
        vm.prank(safe);
        vm.expectRevert(); // the timelock refuses: too early
        d.timelock.execute(address(d.pad), 0, unpause, bytes32(0), salt);
        // ... and runs after it, again with 2 approvals
        vm.warp(block.timestamp + DELAY);
        bytes memory execute =
            abi.encodeCall(TimelockController.execute, (address(d.pad), 0, unpause, bytes32(0), salt));
        _safeCall(address(d.timelock), execute, s1, s2);
        assertFalse(d.pad.paused());
    }

    /// Two owners approve (to, data) at the Safe's current nonce; then anyone executes it.
    function _safeCall(address to, bytes memory data, address a, address b) internal {
        _approve(to, data, a, b);
        safeTx.exec();
    }

    function _approve(address to, bytes memory data, address a, address b) internal {
        vm.setEnv("SAFE", vm.toString(safe));
        vm.setEnv("TO", vm.toString(to));
        vm.setEnv("DATA", vm.toString(data));
        bytes32 h = safeTx.hash();
        vm.prank(a);
        ISafe(safe).approveHash(h);
        vm.prank(b);
        ISafe(safe).approveHash(h);
    }
}
