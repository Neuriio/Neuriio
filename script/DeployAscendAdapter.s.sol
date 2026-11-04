// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {
    AscendAdapter,
    IAscendEscrowFactory,
    IAscendSeatFactory,
    IPermit2,
    IUniversalRouter
} from "../src/launch/AscendAdapter.sol";

/// MAINNET: deploys the real AscendAdapter for an already deployed NeuriioLauncher (script/DeployAscend.s.sol). Anyone can
/// deploy it; plugging it in is the timelock's (the Safe schedules launcher.setAdapter(<this>), waits the delay, executes),
/// as script/rehearse-ascend.sh rehearses. Ascend's addresses are from its docs (Mainnet contracts, 2026-11-04).
///   LAUNCHER=<launcher> forge script script/DeployAscendAdapter.s.sol --rpc-url <elysium mainnet> --broadcast --account <deployer>
contract DeployAscendAdapter is Script {
    uint256 internal constant MAINNET_CHAIN_ID = 99_901;
    address internal constant ESCROW_FACTORY = 0x63f6a8A8d0257c0363251a50cdE8A8b1046e4d19;
    address internal constant SEAT_FACTORY = 0xBDB8d64452191041C4dAA3AD0f64bE4380FEA0b1;
    address internal constant LAUNCHPAD = 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC;
    address internal constant ROUTER = 0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant USDC = 0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65;
    address internal constant BUILDER = 0xB153AA503a2C95fC175275D6b93415869A77e3d1; // approved by Ascend (user, 2026-11-04)

    function run() external returns (AscendAdapter a) {
        require(block.chainid == MAINNET_CHAIN_ID, "not Elysium mainnet");
        address launcher = vm.envAddress("LAUNCHER");
        vm.startBroadcast();
        a = new AscendAdapter(
            launcher,
            IAscendEscrowFactory(ESCROW_FACTORY),
            IAscendSeatFactory(SEAT_FACTORY),
            IUniversalRouter(ROUTER),
            IPermit2(PERMIT2),
            BUILDER
        );
        vm.stopBroadcast();
        require(a.hook() == LAUNCHPAD, "hook: not Ascend's launchpad");
        require(address(a.quote()) == USDC, "launcher: not mainnet USDC");
        console.log("AscendAdapter:", address(a));
        console.log(
            "next: the Safe schedules launcher.setAdapter(adapter) on the timelock, then executes after the delay"
        );
    }
}
