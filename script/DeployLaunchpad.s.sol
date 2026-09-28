// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {Launchpad, ICurveFeeVault} from "../src/launch/Launchpad.sol";
import {FeeVault} from "../src/launch/FeeVault.sol";
import {WHYPE} from "../src/swap/WHYPE.sol";
import {SwapFactory} from "../src/swap/SwapFactory.sol";
import {SwapRouter} from "../src/swap/SwapRouter.sol";
import {ISwapFactory, IWHYPE} from "../src/swap/interfaces.sol";

/// forge script script/DeployLaunchpad.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: WHYPE        existing wrapped HYPE (default: deploy ours)
///      VIRTUAL_HYPE starting virtual HYPE reserve in wei (default 60e18: graduates at ~170 HYPE raised, ~822 HYPE mcap)
///      FEE_BPS      curve trade fee (default 75 = 0.75%)
///      LAUNCH_SIGNER backend key that signs launch passes (required; the Supabase launch-pass function holds it)
/// The deployer owns everything. Fees go to the FeeVault (80% creators, 20% protocol: community 60% / buyback 40%);
/// COMMUNITY_WALLET + BUYBACK_WALLET (optional) set where the protocol share is paid.
contract DeployLaunchpad is Script {
    function run() external returns (Launchpad pad, SwapFactory factory, SwapRouter router, address whype, FeeVault vault) {
        uint256 virtualHype = vm.envOr("VIRTUAL_HYPE", uint256(60e18));
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(75)));
        whype = vm.envOr("WHYPE", address(0));
        address launchSigner = vm.envAddress("LAUNCH_SIGNER");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        if (whype == address(0)) whype = address(new WHYPE());
        factory = new SwapFactory(deployer, whype);
        vault = new FeeVault(deployer, IWHYPE(whype), ISwapFactory(address(factory)));
        pad = new Launchpad(
            deployer, ISwapFactory(address(factory)), IWHYPE(whype), virtualHype, feeBps, launchSigner, ICurveFeeVault(address(vault))
        );
        router = new SwapRouter(ISwapFactory(address(factory)), IWHYPE(whype));
        vault.setLaunchpad(address(pad));
        factory.setLaunchpad(address(pad));
        factory.setFeeVault(address(vault));
        address community = vm.envOr("COMMUNITY_WALLET", address(0));
        address buyback = vm.envOr("BUYBACK_WALLET", address(0));
        if (community != address(0) && buyback != address(0)) vault.setWallets(community, buyback);
        vm.stopBroadcast();

        console.log("WHYPE:", whype);
        console.log("SwapFactory:", address(factory));
        console.log("Launchpad:", address(pad));
        console.log("SwapRouter:", address(router));
        console.log("FeeVault:", address(vault));
    }
}
