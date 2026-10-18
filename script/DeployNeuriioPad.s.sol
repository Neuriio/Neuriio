// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NeuriioPad, ICurveFeeVault} from "../src/launch/NeuriioPad.sol";
import {NeuriioRegistry} from "../src/launch/NeuriioRegistry.sol";
import {ISwapFactory} from "../src/swap/interfaces.sol";

/// A new NeuriioPad VERSION on the existing core (DeployCore.s.sol): approved in the NeuriioRegistry for new launches.
/// Nothing is orphaned: every token keeps its identity in the registry, its pool in the shared factory and its fees
/// in the shared NeuriioFees. RETIRE (optional) = the previous version, revoked for NEW launches only (its tokens keep
/// trading on its curve and graduate normally). The curve is priced in the factory's quote token (USDC).
///   forge script script/DeployNeuriioPad.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: REGISTRY, SWAP_FACTORY, FEE_VAULT (the core), LAUNCH_SIGNER (backend pass signer, required),
///      VIRTUAL_QUOTE (USDC base units; graduation raises ~2.83x it at a market cap of ~13.7x it; mainnet ~$70k cap =
///      5_109e6), FEE_BPS (default 100 = 1%), RETIRE (optional)
contract DeployNeuriioPad is Script {
    function run() external returns (NeuriioPad pad) {
        NeuriioRegistry registry = NeuriioRegistry(vm.envAddress("REGISTRY"));
        ISwapFactory factory = ISwapFactory(vm.envAddress("SWAP_FACTORY"));
        address retire = vm.envOr("RETIRE", address(0));
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        pad = new NeuriioPad(
            deployer,
            factory,
            IERC20(factory.quote()),
            vm.envUint("VIRTUAL_QUOTE"),
            uint16(vm.envOr("FEE_BPS", uint256(100))),
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
