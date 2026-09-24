// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IHyperCoreOracle} from "../src/interfaces/IHyperCoreOracle.sol";
import {KeeperHyperCoreOracle} from "../src/oracle/KeeperHyperCoreOracle.sol";
import {PropAMM} from "../src/amm/PropAMM.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/// Testnet deployment: mock HYPE/USDC tokens, oracle (unless ORACLE is set), seeded pool.
///   forge script script/DeployPropAMM.s.sol --rpc-url elysium_testnet --broadcast --account <keystore>
/// env: ORACLE (reuse existing), SPOT_INDEX (default 107 = HYPE/USDC mainnet Core prices),
///      SEED_PRICE (whole USDC per HYPE for the initial 50/50 seed, default 90), SEED_HYPE (default 100)
contract DeployPropAMM is Script {
    function run() external {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        address oracleAddr = vm.envOr("ORACLE", address(0));
        if (oracleAddr == address(0)) {
            KeeperHyperCoreOracle o = new KeeperHyperCoreOracle(deployer, 500);
            o.setUpdater(deployer, true);
            oracleAddr = address(o);
        }

        MockERC20 hype = new MockERC20("Test HYPE", "tHYPE", 18);
        MockERC20 usdc = new MockERC20("Test USDC", "tUSDC", 6);

        PropAMM amm = new PropAMM(
            deployer,
            IERC20Metadata(address(hype)),
            IERC20Metadata(address(usdc)),
            IHyperCoreOracle(oracleAddr),
            uint32(vm.envOr("SPOT_INDEX", uint256(107))),
            PropAMM.RiskParams({
                minEdgeBps: 5, // >= HyperCore perps taker fee (4.5bps base tier): quotes can never lose to the hedge
                maxTradeBps: 1_000,
                depthFactorBps: 20_000,
                maxAgeMs: 5_000,
                maxL2BlockLag: 50,
                maxCoreSpreadBps: 50
            }),
            // subscription model: price at HyperCore + hedge cost only (no spread profit, no impact, no skew)
            PropAMM.QuoteParams({edgeBps: 5, targetBaseBps: 5_000, skewFactorBps: 0, maxSkewBps: 0, impactBps: 0})
        );
        amm.setQuoter(deployer, true);

        uint256 seedHype = vm.envOr("SEED_HYPE", uint256(100)) * 1e18;
        uint256 seedUsdc = seedHype * vm.envOr("SEED_PRICE", uint256(90)) / 1e12;
        hype.mint(deployer, seedHype * 10);
        usdc.mint(deployer, seedUsdc * 10);
        hype.approve(address(amm), type(uint256).max);
        usdc.approve(address(amm), type(uint256).max);
        amm.deposit(seedHype, seedUsdc);
        vm.stopBroadcast();

        console.log("oracle:", oracleAddr);
        console.log("tHYPE:", address(hype));
        console.log("tUSDC:", address(usdc));
        console.log("PropAMM:", address(amm));
    }
}
