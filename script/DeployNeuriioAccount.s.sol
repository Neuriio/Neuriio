// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {FastBridge} from "../src/bridge/FastBridge.sol";
import {NeuriioAccount} from "../src/account/NeuriioAccount.sol";

/// forge script script/DeployNeuriioAccount.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: BRIDGE (FastBridge the one-click buys deposit into)
/// Stateless and ownerless: users' wallets delegate to it with EIP-7702; no admin can change it.
contract DeployNeuriioAccount is Script {
    function run() external returns (NeuriioAccount account) {
        FastBridge bridge = FastBridge(vm.envAddress("BRIDGE"));
        vm.startBroadcast();
        account = new NeuriioAccount(bridge);
        vm.stopBroadcast();
        console.log("NeuriioAccount:", address(account));
    }
}
