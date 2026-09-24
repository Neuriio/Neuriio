// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IHyperCoreOracle} from "../../src/interfaces/IHyperCoreOracle.sol";
import {KeeperHyperCoreOracle} from "../../src/oracle/KeeperHyperCoreOracle.sol";
import {HyperCoreReader} from "../../src/libraries/HyperCoreReader.sol";
import {ElysiumBlock} from "../../src/libraries/ElysiumBlock.sol";

contract ArbSysStandIn {
    uint256 public arbBlockNumber;

    constructor(uint256 n) {
        arbBlockNumber = n;
    }
}

/// Runs against a fork of the live Elysium testnet (chain 99801). No key or funds needed.
///   forge test --match-path 'test/fork/*' --fork-url elysium_testnet
/// Foundry's EVM doesn't execute Nitro's native precompiles (ArbSys is a 0xfe stub on a fork),
/// so we read the real L2 height over RPC and install a stand-in holding that value.
contract ElysiumTestnetForkTest is Test {
    uint256 l2Height;

    function setUp() public {
        if (block.chainid != 99801) vm.skip(true);
        assertEq(ElysiumBlock.ARB_SYS.code, hex"fe", "ArbSys is a native precompile stub");
        bytes memory raw = vm.rpc("eth_blockNumber", "[]"); // hex quantity as raw big-endian bytes
        for (uint256 i; i < raw.length; ++i) {
            l2Height = (l2Height << 8) | uint8(raw[i]);
        }
        vm.etch(ElysiumBlock.ARB_SYS, address(new ArbSysStandIn(l2Height)).code);
        vm.store(ElysiumBlock.ARB_SYS, 0, bytes32(l2Height));
    }

    /// On Orbit, `block.number` returns the parent (HyperEVM) height. Foundry doesn't emulate that,
    /// so ask the real node to execute NUMBER: init code `NUMBER PUSH0 MSTORE PUSH1 32 PUSH0 RETURN`.
    function test_blockNumberIsParentChainNotL2() public {
        bytes memory raw = vm.rpc("eth_call", '[{"data":"0x435f5260205ff3"},"latest"]');
        uint256 nodeBlockNumber = abi.decode(raw, (uint256));
        assertGt(l2Height, 0);
        assertGt(nodeBlockNumber, l2Height * 100, "block.number on Elysium is HyperEVM's (much larger) height");
        assertEq(ElysiumBlock.number(), l2Height, "ElysiumBlock.number() returns the L2 height");
    }

    /// Documents current reality: the HyperEVM-style precompiles / CoreWriter are not on Elysium yet.
    function test_hyperCorePrecompilesNotYetLive() public view {
        assertEq(address(0x0000000000000000000000000000000000000807).code.length, 0);
        assertEq(address(0x0000000000000000000000000000000000000808).code.length, 0);
        assertEq(address(0x3333333333333333333333333333333333333333).code.length, 0);
    }

    function test_deployPushReadOnFork() public {
        address keeper = makeAddr("keeper");
        KeeperHyperCoreOracle oracle = new KeeperHyperCoreOracle(address(this), 500);
        oracle.setUpdater(keeper, true);

        KeeperHyperCoreOracle.Update[] memory ups = new KeeperHyperCoreOracle.Update[](1);
        ups[0] = KeeperHyperCoreOracle.Update(1035, 25.2e18, 25.21e18, 5e18, 7e18, 0, uint64(block.timestamp) * 1000);
        vm.prank(keeper);
        oracle.push(ups);

        IHyperCoreOracle.Bbo memory b = oracle.bbo(1035);
        assertEq(b.l2Block, l2Height);

        HyperCoreReader.Quote memory q = this.read(oracle);
        assertEq(q.mid, 25.205e18);
    }

    function read(IHyperCoreOracle o) external view returns (HyperCoreReader.Quote memory) {
        return HyperCoreReader.read(o, 1035, HyperCoreReader.Guard(2_000, 0, 50));
    }
}
