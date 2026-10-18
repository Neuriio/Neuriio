// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {NeuriioRegistry} from "../src/launch/NeuriioRegistry.sol";
import {ISwapFactoryAdmin} from "../src/swap/interfaces.sol";

interface ISafe {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

interface IFeeToSetter {
    function setFeeToSetter(address) external;
}

/// Hands every admin power over to a multisig (a Safe). Run by the current owner (the `burner` key).
///   - NeuriioRegistry, every NeuriioPad version, every NeuriioFees, the $NEURIIO token (it picks the minter) and the
///     NeuriioMinter (it approves the fee vaults that mint $NEURIIO and tunes the mint curve until frozen):
///     transferOwnership(safe). (NeuriioRouter and NeuriioStaking have no owner.) These are Ownable2Step, so
///     nothing changes until the SAFE calls acceptOwnership() on each (the script prints those calls). Until then the
///     current owner keeps control and can re-point the transfer if the address was wrong.
///   - UniswapV2Factory: setFeeToSetter(safe). ONE step, takes effect at once and can't be undone by the old key; it runs
///     last, and only after the address is checked to be a live Safe with threshold >= 2.
/// Not moved here: the launch signer (backend key that signs launch passes) and the fee wallets (they only receive).
///   forge script script/TransferOwnership.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: SAFE, REGISTRY, SWAP_FACTORY, FEE_VAULTS (comma-separated: the current vault and any old ones),
///      EXTRA_OWNED (comma-separated: the $NEURIIO token and the NeuriioMinter)
contract TransferOwnership is Script {
    function run() external {
        address safe = vm.envAddress("SAFE");
        NeuriioRegistry registry = NeuriioRegistry(vm.envAddress("REGISTRY"));
        ISwapFactoryAdmin factory = ISwapFactoryAdmin(vm.envAddress("SWAP_FACTORY"));
        address[] memory vaults = vm.envAddress("FEE_VAULTS", ",");
        address[] memory extra = vm.envOr("EXTRA_OWNED", ",", new address[](0));

        // the factory step is irreversible: refuse anything that isn't a live Safe needing 2+ signatures
        require(safe.code.length > 0, "SAFE has no code (not deployed on this chain?)");
        uint256 threshold = ISafe(safe).getThreshold();
        address[] memory owners = ISafe(safe).getOwners();
        require(threshold >= 2 && owners.length >= threshold, "SAFE must need at least 2 signatures");
        console.log("Safe:", safe);
        console.log("  threshold:", threshold, "of", owners.length);
        for (uint256 i; i < owners.length; ++i) {
            console.log("  owner:", owners[i]);
        }

        // everything this script touches, Ownable2Step first
        uint256 pads = registry.launchpadsLength();
        address[] memory owned = new address[](1 + pads + vaults.length + extra.length);
        owned[0] = address(registry);
        for (uint256 i; i < pads; ++i) {
            owned[1 + i] = registry.launchpads(i);
        }
        for (uint256 i; i < vaults.length; ++i) {
            owned[1 + pads + i] = vaults[i];
        }
        for (uint256 i; i < extra.length; ++i) {
            owned[1 + pads + vaults.length + i] = extra[i];
        }

        vm.startBroadcast();
        (, address me,) = vm.readCallers();
        for (uint256 i; i < owned.length; ++i) {
            Ownable2Step c = Ownable2Step(owned[i]);
            if (c.owner() == safe) continue; // already done
            require(c.owner() == me, "not the current owner of every contract");
            c.transferOwnership(safe);
        }
        if (factory.feeToSetter() != safe) {
            require(factory.feeToSetter() == me, "not the factory's feeToSetter");
            IFeeToSetter(address(factory)).setFeeToSetter(safe);
        }
        vm.stopBroadcast();

        console.log("");
        console.log("Factory feeToSetter is now the Safe (done).");
        console.log("");
        console.log("NEXT: the Safe must call acceptOwnership() (data 0x79ba5097, value 0) on each of these:");
        for (uint256 i; i < owned.length; ++i) {
            if (Ownable2Step(owned[i]).owner() != safe) console.log("ACCEPT", owned[i]);
        }
    }
}
