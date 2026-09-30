// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Launchpad, ICurveFeeVault} from "../src/launch/Launchpad.sol";
import {LaunchRegistry} from "../src/launch/LaunchRegistry.sol";
import {FeeVault} from "../src/launch/FeeVault.sol";
import {ISwapFactory, ISwapFactoryAdmin, IWHYPE} from "../src/swap/interfaces.sol";

/// Swaps in a new FeeVault (a fix, a new fee split): deploys it, points the factory (every pool, from their next swap)
/// and every Launchpad version (curve fees) at it. Creators' balances in the old vault stay claimable there (the app
/// sums every vault in deployments `feeVaults`). Protocol wallets carry over if the old vault had them set.
///   forge script script/ReplaceFeeVault.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: REGISTRY, SWAP_FACTORY, WHYPE, OLD_FEE_VAULT
contract ReplaceFeeVault is Script {
    function run() external returns (FeeVault vault) {
        LaunchRegistry registry = LaunchRegistry(vm.envAddress("REGISTRY"));
        ISwapFactoryAdmin factory = ISwapFactoryAdmin(vm.envAddress("SWAP_FACTORY"));
        FeeVault old = FeeVault(payable(vm.envAddress("OLD_FEE_VAULT")));
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        vault = new FeeVault(deployer, IWHYPE(vm.envAddress("WHYPE")), ISwapFactory(address(factory)), registry);
        if (old.communityWallet() != address(0)) vault.setWallets(old.communityWallet(), old.buybackWallet());
        vault.setCommunityBps(old.communityBps());
        factory.setFeeVault(address(vault));
        for (uint256 i; i < registry.launchpadsLength(); ++i) {
            Launchpad(payable(registry.launchpads(i))).setFeeVault(ICurveFeeVault(address(vault)));
        }
        vm.stopBroadcast();
        console.log("FeeVault:", address(vault));
    }
}
