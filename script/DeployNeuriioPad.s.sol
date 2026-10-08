// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {NeuriioPad, ICurveFeeVault} from "../src/launch/NeuriioPad.sol";
import {NeuriioRegistry} from "../src/launch/NeuriioRegistry.sol";
import {ISwapFactory, IWHYPE} from "../src/swap/interfaces.sol";

/// A new NeuriioPad VERSION on the existing core (DeployCore.s.sol): approved in the NeuriioRegistry for new launches.
/// Nothing is orphaned: every token keeps its identity in the registry, its pool in the shared factory and its fees
/// in the shared NeuriioFees. RETIRE (optional) = the previous version, revoked for NEW launches only (its tokens keep
/// trading on its curve and graduate normally).
///   forge script script/DeployNeuriioPad.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: REGISTRY, SWAP_FACTORY, WHYPE, FEE_VAULT (the core), LAUNCH_SIGNER (backend pass signer, required),
///      VIRTUAL_HYPE (wei, default 60e18 -> graduates at ~170 HYPE raised), FEE_BPS (default 75), RETIRE (optional)
contract DeployNeuriioPad is Script {
    function run() external returns (NeuriioPad pad) {
        NeuriioRegistry registry = NeuriioRegistry(vm.envAddress("REGISTRY"));
        address retire = vm.envOr("RETIRE", address(0));
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        pad = new NeuriioPad(
            deployer,
            ISwapFactory(vm.envAddress("SWAP_FACTORY")),
            IWHYPE(vm.envAddress("WHYPE")),
            vm.envOr("VIRTUAL_HYPE", uint256(60e18)),
            uint16(vm.envOr("FEE_BPS", uint256(75))),
            vm.envAddress("LAUNCH_SIGNER"),
            ICurveFeeVault(vm.envAddress("FEE_VAULT")),
            registry
        );
        registry.setLaunchpad(address(pad), true);
        if (retire != address(0)) registry.setLaunchpad(retire, false);
        vm.stopBroadcast();
        console.log("NeuriioPad:", address(pad));
        if (retire != address(0)) console.log("Retired (no new launches):", retire);
    }
}
