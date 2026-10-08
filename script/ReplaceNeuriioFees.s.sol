// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {NeuriioPad, ICurveFeeVault} from "../src/launch/NeuriioPad.sol";
import {NeuriioRegistry} from "../src/launch/NeuriioRegistry.sol";
import {NeuriioFees} from "../src/launch/NeuriioFees.sol";
import {ISwapFactory, ISwapFactoryAdmin, IWHYPE} from "../src/swap/interfaces.sol";

/// Swaps in a new NeuriioFees (a fix, a new fee split): deploys it, points the factory (every pool, from their next swap)
/// and every NeuriioPad version (curve fees) at it. Creators' balances in the old vault stay claimable there (the app
/// sums every vault in deployments `feeVaults`). Protocol wallets carry over if the old vault had them set.
///   forge script script/ReplaceNeuriioFees.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: REGISTRY, SWAP_FACTORY, WHYPE, OLD_FEE_VAULT
contract ReplaceNeuriioFees is Script {
    function run() external returns (NeuriioFees vault) {
        NeuriioRegistry registry = NeuriioRegistry(vm.envAddress("REGISTRY"));
        ISwapFactoryAdmin factory = ISwapFactoryAdmin(vm.envAddress("SWAP_FACTORY"));
        NeuriioFees old = NeuriioFees(payable(vm.envAddress("OLD_FEE_VAULT")));
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        vault = new NeuriioFees(deployer, IWHYPE(vm.envAddress("WHYPE")), ISwapFactory(address(factory)), registry);
        if (old.communityWallet() != address(0)) vault.setWallets(old.communityWallet(), old.buybackWallet());
        vault.setCommunityBps(old.communityBps());
        factory.setFeeVault(address(vault));
        for (uint256 i; i < registry.launchpadsLength(); ++i) {
            NeuriioPad(payable(registry.launchpads(i))).setFeeVault(ICurveFeeVault(address(vault)));
        }
        vm.stopBroadcast();
        console.log("NeuriioFees:", address(vault));
    }
}
