// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {NeuriioRegistry} from "../src/launch/NeuriioRegistry.sol";
import {NeuriioFees} from "../src/launch/NeuriioFees.sol";
import {WHYPE} from "../src/swap/WHYPE.sol";
import {NeuriioSwap} from "../src/swap/NeuriioSwap.sol";
import {ISwapFactory, ISwapFactoryAdmin, IWHYPE} from "../src/swap/interfaces.sol";

/// The PERMANENT core, deployed once per network (never for an upgrade): NeuriioRegistry (identity + every token's
/// NeuriioPad and creators), our Uniswap V2 fork factory (every pool), NeuriioFees (every fee), NeuriioSwap, WHYPE.
/// NeuriioPad versions are deployed on top with DeployNeuriioPad.s.sol.
///   forge script script/DeployCore.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: WHYPE existing wrapped HYPE (default: deploy ours); COMMUNITY_WALLET + BUYBACK_WALLET (optional) for the
/// protocol share. The deployer owns everything (it is the factory's feeToSetter).
contract DeployCore is Script {
    function run()
        external
        returns (
            NeuriioRegistry registry,
            ISwapFactoryAdmin factory,
            NeuriioFees vault,
            NeuriioSwap router,
            address whype
        )
    {
        whype = vm.envOr("WHYPE", address(0));
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        if (whype == address(0)) whype = address(new WHYPE());
        registry = new NeuriioRegistry(deployer);
        factory = ISwapFactoryAdmin(deployCode("UniswapV2Factory.sol:UniswapV2Factory", abi.encode(deployer, whype)));
        factory.setRegistry(address(registry));
        vault = new NeuriioFees(deployer, IWHYPE(whype), ISwapFactory(address(factory)), registry);
        factory.setFeeVault(address(vault));
        router = new NeuriioSwap(ISwapFactory(address(factory)), IWHYPE(whype));
        address community = vm.envOr("COMMUNITY_WALLET", address(0));
        address buyback = vm.envOr("BUYBACK_WALLET", address(0));
        if (community != address(0) && buyback != address(0)) vault.setWallets(community, buyback);
        vm.stopBroadcast();

        console.log("WHYPE:", whype);
        console.log("NeuriioRegistry:", address(registry));
        console.log("SwapFactory (UniswapV2Factory):", address(factory));
        console.log("NeuriioFees:", address(vault));
        console.log("NeuriioSwap:", address(router));
    }
}
