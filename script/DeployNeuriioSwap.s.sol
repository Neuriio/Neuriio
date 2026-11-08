// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {NeuriioSwap} from "../src/trade/NeuriioSwap.sol";
import {IPermit2, IUniversalRouter, PoolKey} from "../src/launch/AscendAdapter.sol";

/// MAINNET: deploys NeuriioSwap (Universal Frontend, user 2026-11-07). The real one is owned by the timelock the Neuriio Safe
/// runs, with the Safe as guardian; pools are then approved through the timelock (setPool, 1-day delay).
/// A TEST instance for small trades before the audit: set OWNER to your own wallet (the deployer must be that OWNER), and
/// TEST_TOKENS to Ascend tokens paired with WHYPE (comma list): their Ascend pools are approved at once. Never route real users
/// through a test instance.
///   forge script script/DeployNeuriioSwap.s.sol --rpc-url <elysium mainnet> --broadcast --interactives 1 --sender <deployer>
/// env: OWNER (default: the timelock), TEST_TOKENS (optional, test instance only)
contract DeployNeuriioSwap is Script {
    uint256 internal constant MAINNET_CHAIN_ID = 99_901;
    address internal constant ROUTER = 0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant WHYPE = 0xbA876237B0F021A6c6D852d6c26E107997cC5E81;
    address internal constant FEE_WALLET = 0xB153AA503a2C95fC175275D6b93415869A77e3d1;
    address internal constant SAFE = 0x68Ed49C77dF7fB4928510d5Ac65C6074674D264E;
    address internal constant TIMELOCK = 0x784439860cD5c58dAad8fDcfB96c2Bba901e6eA9;
    address internal constant ASCEND_HOOK = 0xe0dEF4221b9840a610D4e7d55812a79A6431a8eC; // Ascend's launchpad

    function run() external returns (NeuriioSwap s) {
        require(block.chainid == MAINNET_CHAIN_ID, "not Elysium mainnet");
        address owner = vm.envOr("OWNER", TIMELOCK);
        address[] memory testTokens = vm.envOr("TEST_TOKENS", ",", new address[](0));
        require(testTokens.length == 0 || owner != TIMELOCK, "TEST_TOKENS is only for a test instance you own");
        vm.startBroadcast();
        s = new NeuriioSwap(owner, IUniversalRouter(ROUTER), IPermit2(PERMIT2), WHYPE, FEE_WALLET, SAFE);
        for (uint256 i; i < testTokens.length; ++i) {
            address t = testTokens[i];
            (address c0, address c1) = t < WHYPE ? (t, WHYPE) : (WHYPE, t);
            s.setPool(PoolKey(c0, c1, 0x800000, 200, ASCEND_HOOK), t, true); // Ascend's pool key for a WHYPE pair
        }
        vm.stopBroadcast();
        require(s.owner() == owner && s.guardian() == SAFE && s.feeWallet() == FEE_WALLET, "setup");
        require(address(s.router()) == ROUTER && address(s.permit2()) == PERMIT2 && s.whype() == WHYPE, "routes");
        console.log("NeuriioSwap:", address(s));
        console.log(owner == TIMELOCK ? "owner: the timelock (real instance)" : "owner: your wallet (TEST instance)");
        if (testTokens.length > 0) console.log("approved Ascend WHYPE pools:", testTokens.length);
    }
}
