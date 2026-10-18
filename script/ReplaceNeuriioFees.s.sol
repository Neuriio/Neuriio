// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NeuriioPad, ICurveFeeVault} from "../src/launch/NeuriioPad.sol";
import {NeuriioRegistry} from "../src/launch/NeuriioRegistry.sol";
import {NeuriioFees} from "../src/launch/NeuriioFees.sol";
import {NeuriioStaking} from "../src/stake/NeuriioStaking.sol";
import {NeuriioMinter} from "../src/stake/NeuriioMinter.sol";
import {ISwapFactory, ISwapFactoryAdmin} from "../src/swap/interfaces.sol";
import {Script} from "forge-std/Script.sol";

/// Swaps in a new NeuriioFees (a fix, a new fee split): deploys it, points the factory (every pool, from their next swap)
/// and every NeuriioPad version (curve fees) at it. Creators' balances in the old vault stay claimable there (the app
/// sums every vault in deployments `feeVaults`). Protocol wallets carry over if the old vault had them set.
///   forge script script/ReplaceNeuriioFees.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: REGISTRY, SWAP_FACTORY, OLD_FEE_VAULT, STAKING, MINTER (the new vault is approved there)
contract ReplaceNeuriioFees is Script {
    function run() external returns (NeuriioFees vault) {
        NeuriioRegistry registry = NeuriioRegistry(vm.envAddress("REGISTRY"));
        ISwapFactoryAdmin factory = ISwapFactoryAdmin(vm.envAddress("SWAP_FACTORY"));
        NeuriioFees old = NeuriioFees(vm.envAddress("OLD_FEE_VAULT"));
        NeuriioStaking staking = NeuriioStaking(vm.envAddress("STAKING"));
        NeuriioMinter minter = NeuriioMinter(vm.envAddress("MINTER"));
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        vault = new NeuriioFees(
            deployer, IERC20(factory.quote()), ISwapFactory(address(factory)), registry, staking, minter
        );
        if (old.treasuryWallet() != address(0)) vault.setWallets(old.treasuryWallet(), old.buybackWallet());
        minter.setVault(address(vault), true);
        minter.setVault(address(old), false);
        factory.setFeeVault(address(vault));
        for (uint256 i; i < registry.launchpadsLength(); ++i) {
            NeuriioPad(registry.launchpads(i)).setFeeVault(ICurveFeeVault(address(vault)));
        }
        vm.stopBroadcast();
        console.log("NeuriioFees:", address(vault));
    }
}
