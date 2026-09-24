// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {KeeperHyperCoreOracle} from "../src/oracle/KeeperHyperCoreOracle.sol";

/// forge script script/DeployOracle.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: KEEPER (updater address, defaults to the deployer), MAX_FUTURE_DRIFT_MS (default 500)
contract DeployOracle is Script {
    function run() external returns (KeeperHyperCoreOracle oracle) {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        address keeper = vm.envOr("KEEPER", deployer);
        oracle = new KeeperHyperCoreOracle(deployer, uint64(vm.envOr("MAX_FUTURE_DRIFT_MS", uint256(500))));
        oracle.setUpdater(keeper, true);
        vm.stopBroadcast();
        console.log("KeeperHyperCoreOracle:", address(oracle));
        console.log("updater:", keeper);
    }
}
