// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {LaunchRegistry} from "../src/launch/LaunchRegistry.sol";
import {FeeVault} from "../src/launch/FeeVault.sol";
import {WHYPE} from "../src/swap/WHYPE.sol";
import {SwapRouter} from "../src/swap/SwapRouter.sol";
import {ISwapFactory, ISwapFactoryAdmin, IWHYPE} from "../src/swap/interfaces.sol";

/// The PERMANENT core, deployed once per network (never for an upgrade): LaunchRegistry (identity + every token's
/// Launchpad and creators), our Uniswap V2 fork factory (every pool), FeeVault (every fee), SwapRouter, WHYPE.
/// Launchpad versions are deployed on top with DeployLaunchpad.s.sol.
///   forge script script/DeployCore.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: WHYPE existing wrapped HYPE (default: deploy ours); COMMUNITY_WALLET + BUYBACK_WALLET (optional) for the
/// protocol share. The deployer owns everything (it is the factory's feeToSetter).
contract DeployCore is Script {
    function run() external returns (LaunchRegistry registry, ISwapFactoryAdmin factory, FeeVault vault, SwapRouter router, address whype) {
        whype = vm.envOr("WHYPE", address(0));
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        if (whype == address(0)) whype = address(new WHYPE());
        registry = new LaunchRegistry(deployer);
        factory = ISwapFactoryAdmin(deployCode("UniswapV2Factory.sol:UniswapV2Factory", abi.encode(deployer, whype)));
        factory.setRegistry(address(registry));
        vault = new FeeVault(deployer, IWHYPE(whype), ISwapFactory(address(factory)), registry);
        factory.setFeeVault(address(vault));
        router = new SwapRouter(ISwapFactory(address(factory)), IWHYPE(whype));
        address community = vm.envOr("COMMUNITY_WALLET", address(0));
        address buyback = vm.envOr("BUYBACK_WALLET", address(0));
        if (community != address(0) && buyback != address(0)) vault.setWallets(community, buyback);
        vm.stopBroadcast();

        console.log("WHYPE:", whype);
        console.log("LaunchRegistry:", address(registry));
        console.log("SwapFactory (UniswapV2Factory):", address(factory));
        console.log("FeeVault:", address(vault));
        console.log("SwapRouter:", address(router));
    }
}
