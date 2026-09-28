// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IWHYPE is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// Uniswap-V2-shaped, so existing V2 aggregator adapters work (fee = 25 bps).
interface ISwapPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function mint(address to) external returns (uint256 liquidity);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function skim(address to) external;
    function sync() external;
}

interface ISwapFactory {
    function whype() external view returns (address);
    function feeVault() external view returns (address);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

/// Receives every pool's 0.25% fee (as WHYPE) and credits it to the token's creator + protocol.
interface IFeeVault {
    function notifyPoolFee(address token) external;
}

/// Flash-swap callback (called on `to` when `swap` gets non-empty `data`).
interface ISwapCallee {
    function swapCall(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}
