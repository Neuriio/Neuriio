// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ILaunchedTokens, NeuriioTokenStaking} from "../src/stake/NeuriioTokenStaking.sol";
import {NeuriioLauncher} from "../src/launch/NeuriioLauncher.sol";

/// MAINNET for the Ascend version, in one run: a TimelockController only the Safe runs, NeuriioLauncher owned by it from its
/// first block with the Safe as guardian (it can pause at once, nothing else), and NeuriioTokenStaking, which has no owner.
/// The deployer never holds any power. The adapter is plugged in later, through the timelock, once Ascend's contracts are
/// known; until then launches revert. `check` reads all of this back on-chain; test/DeployAscend.t.sol runs it.
///   forge script script/DeployAscend.s.sol --rpc-url <elysium mainnet> --broadcast --account <deployer keystore>
/// env: USDC (6 decimals), SAFE (a deployed multisig), LAUNCH_SIGNER (a new key, never the testnet one), TIMELOCK_DELAY
///   (seconds: at least 1 day; a rehearsal on the testnet chain: at least 5 minutes, with ALLOW_TESTNET=true).
contract DeployAscend is Script {
    uint256 internal constant TESTNET_CHAIN_ID = 99_801;
    address internal constant TESTNET_LAUNCH_SIGNER = 0x25626586434fb2003d12957a1fC4B0fA5EA52886;

    struct Params {
        address usdc;
        address safe;
        address launchSigner;
        uint256 timelockDelay;
    }

    struct Deployment {
        TimelockController timelock;
        NeuriioLauncher launcher;
        NeuriioTokenStaking staking;
    }

    function run() external returns (Deployment memory d) {
        Params memory p = Params(
            vm.envAddress("USDC"), vm.envAddress("SAFE"), vm.envAddress("LAUNCH_SIGNER"), vm.envUint("TIMELOCK_DELAY")
        );
        validate(p, vm.envOr("ALLOW_TESTNET", false));
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d = deploy(p);
        vm.stopBroadcast();
        check(d, p, deployer);
        console.log("TimelockController:", address(d.timelock));
        console.log("NeuriioLauncher:", address(d.launcher));
        console.log("NeuriioTokenStaking:", address(d.staking));
    }

    /// Refuses settings that don't look like mainnet.
    function validate(Params memory p, bool allowTestnet) public view {
        bool rehearsal = block.chainid == TESTNET_CHAIN_ID;
        require(!rehearsal || allowTestnet, "testnet: set ALLOW_TESTNET");
        require(p.usdc.code.length > 0 && IERC20Metadata(p.usdc).decimals() == 6, "USDC: not a 6-decimal token");
        require(p.safe.code.length > 0, "SAFE: not a deployed multisig");
        require(p.launchSigner != address(0) && p.launchSigner != TESTNET_LAUNCH_SIGNER, "LAUNCH_SIGNER: use a new key");
        require(p.timelockDelay >= (rehearsal ? 5 minutes : 1 days), "TIMELOCK_DELAY: too short");
    }

    function deploy(Params memory p) public returns (Deployment memory d) {
        address[] memory safeOnly = new address[](1);
        safeOnly[0] = p.safe;
        d.timelock = new TimelockController(p.timelockDelay, safeOnly, safeOnly, address(0));
        d.launcher = new NeuriioLauncher(address(d.timelock), IERC20(p.usdc), p.launchSigner, p.safe);
        d.staking = new NeuriioTokenStaking(IERC20(p.usdc), ILaunchedTokens(address(d.launcher)));
    }

    /// Everything the deploy promises, read back on-chain; reverts on the first thing that's off.
    function check(Deployment memory d, Params memory p, address deployer) public view {
        address tl = address(d.timelock);
        require(d.launcher.owner() == tl && d.launcher.pendingOwner() == address(0), "launcher: owner");
        require(d.launcher.guardian() == p.safe && !d.launcher.paused(), "launcher: guardian / paused");
        require(d.launcher.launchSigner() == p.launchSigner, "launcher: signer");
        require(address(d.launcher.quote()) == p.usdc, "launcher: quote");
        require(address(d.launcher.adapter()) == address(0), "launcher: adapter");
        require(address(d.staking.quote()) == p.usdc, "staking: quote");
        require(address(d.staking.launcher()) == address(d.launcher), "staking: launcher");
        TimelockController t = d.timelock;
        require(t.getMinDelay() == p.timelockDelay, "timelock: delay");
        bytes32[4] memory roles = [t.PROPOSER_ROLE(), t.EXECUTOR_ROLE(), t.CANCELLER_ROLE(), t.DEFAULT_ADMIN_ROLE()];
        for (uint256 i; i < 4; ++i) {
            require(!t.hasRole(roles[i], deployer), "timelock: the deployer has a role");
            require(t.hasRole(roles[i], p.safe) == (i < 3), "timelock: the Safe's roles");
        }
        require(t.hasRole(roles[3], tl), "timelock: not self-administered");
    }
}
