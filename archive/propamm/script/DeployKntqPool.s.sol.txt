// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IHyperCoreOracle} from "../src/interfaces/IHyperCoreOracle.sol";
import {PropAMM} from "../src/amm/PropAMM.sol";
import {FastBridge} from "../src/bridge/FastBridge.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/// Testnet: a second PropAMM, tKNTQ/tUSDC, priced off HyperCore MAINNET KNTQ/USDC spot (pair 334), and
/// registered with FastBridge so KNTQ can pay for one-click buys. Sized for small test trades
/// (~$100 in and out of perps / outcomes): maxTrade = 10% of pool value.
///   forge script script/DeployKntqPool.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: ORACLE, USDC (existing tUSDC), BRIDGE (existing FastBridge), SEED_PRICE_E6 (USDC per KNTQ in
///      1e-6 units, e.g. 325300 = $0.3253), SEED_KNTQ (whole KNTQ per side, default 5000), SPOT_INDEX (334)
contract DeployKntqPool is Script {
    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        MockERC20 usdc = MockERC20(vm.envAddress("USDC"));
        FastBridge bridge = FastBridge(vm.envAddress("BRIDGE"));
        MockERC20 kntq = new MockERC20("Test KNTQ", "tKNTQ", 18);

        PropAMM amm = new PropAMM(
            deployer,
            IERC20Metadata(address(kntq)),
            IERC20Metadata(address(usdc)),
            IHyperCoreOracle(vm.envAddress("ORACLE")),
            uint32(vm.envOr("SPOT_INDEX", uint256(334))),
            PropAMM.RiskParams({
                // KNTQ has no HyperCore perp: it would be hedged on SPOT, whose taker fee (~7 bps base
                // tier) is above the perps fee, so the floor is 8 bps, not HYPE's 5
                minEdgeBps: 8,
                maxTradeBps: 1_000,
                depthFactorBps: 20_000,
                maxAgeMs: 5_000,
                maxL2BlockLag: 50,
                maxCoreSpreadBps: 50
            }),
            PropAMM.QuoteParams({edgeBps: 8, targetBaseBps: 5_000, skewFactorBps: 0, maxSkewBps: 0, impactBps: 0})
        );
        amm.setQuoter(deployer, true);

        uint256 seedKntq = vm.envOr("SEED_KNTQ", uint256(5_000)) * 1e18;
        uint256 seedUsdc = seedKntq * vm.envUint("SEED_PRICE_E6") / 1e18; // 6-dp USDC
        kntq.mint(deployer, seedKntq * 10); // extra for test swaps / one-click payments
        usdc.mint(deployer, seedUsdc);
        kntq.approve(address(amm), type(uint256).max);
        usdc.approve(address(amm), type(uint256).max);
        amm.deposit(seedKntq, seedUsdc);

        bridge.setPool(address(kntq), amm); // KNTQ -> USDC conversion for FastBridge.deposit
        vm.stopBroadcast();

        console.log("tKNTQ:", address(kntq));
        console.log("PropAMM (tKNTQ/tUSDC):", address(amm));
        console.log("seeded KNTQ:", seedKntq / 1e18);
        console.log("seeded USDC:", seedUsdc / 1e6);
    }
}
