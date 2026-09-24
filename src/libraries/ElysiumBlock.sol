// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}

/// @notice Elysium is an Arbitrum Orbit chain: `block.number` returns the *parent chain*
///         (HyperEVM) block number, not the L2 block. The real L2 height comes from ArbSys.
library ElysiumBlock {
    address internal constant ARB_SYS = address(0x64);

    function number() internal view returns (uint64) {
        // Fallback keeps plain anvil / non-Orbit test environments usable.
        if (ARB_SYS.code.length == 0) return uint64(block.number);
        return uint64(IArbSys(ARB_SYS).arbBlockNumber());
    }

    /// @dev `block.timestamp` has 1s resolution on Nitro; this is floor(now) in ms.
    function timestampMs() internal view returns (uint64) {
        return uint64(block.timestamp) * 1000;
    }
}
