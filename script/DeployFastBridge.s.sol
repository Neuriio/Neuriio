// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IUsdcPool} from "../src/interfaces/IUsdcPool.sol";
import {FastBridge} from "../src/bridge/FastBridge.sol";

/// forge script script/DeployFastBridge.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: POOL (a USDC pool, e.g. the archived PropAMM, whose quote token is USDC; its base becomes a supported deposit token)
///      RELAYER (defaults to deployer)
contract DeployFastBridge is Script {
    function run() external returns (FastBridge bridge) {
        IUsdcPool pool = IUsdcPool(vm.envAddress("POOL"));
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        bridge = new FastBridge(
            deployer,
            pool.quote(),
            FastBridge.Config({
                feeBps: 0, // subscription model: no bridge fee (HyperCore's own $1 new-account fee is passed on)
                minFee: 0,
                maxDeposit: 25_000e6,
                refundDelay: 1 hours,
                maxPayout: 25_000e6,
                dailyPayoutCap: 100_000e6
            })
        );
        bridge.setRelayer(vm.envOr("RELAYER", deployer), true);
        bridge.setPool(address(pool.base()), pool);
        vm.stopBroadcast();
        console.log("FastBridge:", address(bridge));
    }
}
