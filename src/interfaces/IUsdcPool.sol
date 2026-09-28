// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice What FastBridge needs from a pool that converts a token to USDC. Matches the (paused, archived)
/// PropAMM's ABI, so pools already deployed keep working. See archive/propamm/.
interface IUsdcPool {
    function base() external view returns (IERC20);
    function quote() external view returns (IERC20);
    function sellBase(uint256 baseIn, uint256 minQuoteOut, address recipient, uint256 deadline)
        external
        returns (uint256 quoteOut);
}
