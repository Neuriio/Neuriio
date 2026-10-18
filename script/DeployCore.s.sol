// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NeuriioRegistry} from "../src/launch/NeuriioRegistry.sol";
import {NeuriioFees} from "../src/launch/NeuriioFees.sol";
import {NeuriioRouter} from "../src/swap/NeuriioRouter.sol";
import {NeuriioStaking} from "../src/stake/NeuriioStaking.sol";
import {NeuriioMinter} from "../src/stake/NeuriioMinter.sol";
import {TestUSDC} from "../src/testnet/TestUSDC.sol";
import {ISwapFactory, ISwapFactoryAdmin} from "../src/swap/interfaces.sol";
import {NeuriioConfig} from "./NeuriioConfig.sol";

/// The PERMANENT core, deployed once per network (never for an upgrade), all priced in USDC: NeuriioRegistry
/// (identity + every token's NeuriioPad and creators), our Uniswap V2 fork factory (every TOKEN/USDC pool, 1% fee),
/// NeuriioStaking (+ the $NEURIIO token it deploys), NeuriioMinter, NeuriioFees (every fee) and NeuriioRouter (every
/// app trade). NeuriioPad versions are deployed on top with DeployNeuriioPad.s.sol.
///   forge script script/DeployCore.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: USDC (mainnet: the bridged USDC; unset on testnet = deploy our TestUSDC, mintable only by FAUCET),
/// FAUCET (testnet: the faucet wallet allowed to mint test USDC), TREASURY_WALLET + BUYBACK_WALLET (optional), the
/// mint curve (NeuriioConfig). The deployer owns everything (it is the factory's
/// feeToSetter and the $NEURIIO owner).
contract DeployCore is NeuriioConfig {
    function run() external {
        address usdc = vm.envOr("USDC", address(0));
        address faucet = vm.envOr("FAUCET", address(0));
        (uint256 rate, uint256 flatUntil, uint256 decayScale) = _mintCurve();
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        if (usdc == address(0)) {
            TestUSDC test = new TestUSDC(deployer);
            if (faucet != address(0)) test.setMinter(faucet, true);
            usdc = address(test);
        }
        NeuriioRegistry registry = new NeuriioRegistry(deployer);
        ISwapFactoryAdmin factory =
            ISwapFactoryAdmin(deployCode("UniswapV2Factory.sol:UniswapV2Factory", abi.encode(deployer, usdc)));
        factory.setRegistry(address(registry));
        NeuriioStaking staking = new NeuriioStaking(ISwapFactory(address(factory)), IERC20(usdc), deployer);
        NeuriioMinter minter = new NeuriioMinter(deployer, staking, rate, flatUntil, decayScale);
        staking.neuriio().setMinter(address(minter));
        NeuriioFees vault =
            new NeuriioFees(deployer, IERC20(usdc), ISwapFactory(address(factory)), registry, staking, minter);
        minter.setVault(address(vault), true);
        factory.setFeeVault(address(vault));
        NeuriioRouter trade = new NeuriioRouter(registry, ISwapFactory(address(factory)));
        address treasury = vm.envOr("TREASURY_WALLET", address(0));
        address buyback = vm.envOr("BUYBACK_WALLET", address(0));
        if (treasury != address(0) && buyback != address(0)) vault.setWallets(treasury, buyback);
        vm.stopBroadcast();

        console.log("USDC:", usdc);
        console.log("NeuriioRegistry:", address(registry));
        console.log("SwapFactory (UniswapV2Factory):", address(factory));
        console.log("NeuriioStaking:", address(staking));
        console.log("NeuriioPlatformToken:", address(staking.neuriio()));
        console.log("NeuriioMinter:", address(minter));
        console.log("NeuriioFees:", address(vault));
        console.log("NeuriioRouter:", address(trade));
    }
}
