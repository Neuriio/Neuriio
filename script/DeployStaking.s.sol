// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NeuriioRegistry} from "../src/launch/NeuriioRegistry.sol";
import {NeuriioFees} from "../src/launch/NeuriioFees.sol";
import {NeuriioPad, ICurveFeeVault} from "../src/launch/NeuriioPad.sol";
import {NeuriioRouter} from "../src/swap/NeuriioRouter.sol";
import {NeuriioStaking} from "../src/stake/NeuriioStaking.sol";
import {NeuriioMinter} from "../src/stake/NeuriioMinter.sol";
import {ISwapFactory, ISwapFactoryAdmin} from "../src/swap/interfaces.sol";
import {NeuriioConfig} from "./NeuriioConfig.sol";

/// Puts the staking side (NeuriioStaking + a fresh $NEURIIO, NeuriioMinter, NeuriioFees, NeuriioRouter) on an existing
/// core (registry, factory, USDC) and points the factory and every NeuriioPad version at the new vault. Old vault
/// balances stay claimable there.
///   forge script script/DeployStaking.s.sol --rpc-url elysium_testnet --broadcast --private-key <key>
/// env: REGISTRY, SWAP_FACTORY, TREASURY_WALLET, BUYBACK_WALLET, and the mint curve (NeuriioConfig)
contract DeployStaking is NeuriioConfig {
    function run() external {
        NeuriioRegistry registry = NeuriioRegistry(vm.envAddress("REGISTRY"));
        ISwapFactoryAdmin factory = ISwapFactoryAdmin(vm.envAddress("SWAP_FACTORY"));
        (uint256 rate, uint256 flatUntil, uint256 decayScale) = _mintCurve();
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        IERC20 usdc = IERC20(factory.quote());
        NeuriioStaking staking = new NeuriioStaking(ISwapFactory(address(factory)), usdc, deployer);
        NeuriioMinter minter = new NeuriioMinter(deployer, staking, rate, flatUntil, decayScale);
        staking.neuriio().setMinter(address(minter));
        NeuriioFees vault = new NeuriioFees(deployer, usdc, ISwapFactory(address(factory)), registry, staking, minter);
        minter.setVault(address(vault), true);
        vault.setWallets(vm.envAddress("TREASURY_WALLET"), vm.envAddress("BUYBACK_WALLET"));
        NeuriioRouter trade = new NeuriioRouter(registry, ISwapFactory(address(factory)));
        factory.setFeeVault(address(vault));
        for (uint256 i; i < registry.launchpadsLength(); ++i) {
            NeuriioPad(registry.launchpads(i)).setFeeVault(ICurveFeeVault(address(vault)));
        }
        vm.stopBroadcast();
        console.log("NeuriioStaking:", address(staking));
        console.log("NeuriioPlatformToken:", address(staking.neuriio()));
        console.log("NeuriioMinter:", address(minter));
        console.log("NeuriioFees:", address(vault));
        console.log("NeuriioRouter:", address(trade));
    }
}
