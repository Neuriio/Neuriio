// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// The pair: our Uniswap V2 fork (src/swap/v2), TOKEN/USDC, so existing V2 aggregator adapters work (fee = 100 bps).
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
    /// The token every pool is priced in (USDC).
    function quote() external view returns (address);
    function feeVault() external view returns (address);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function createPair(address tokenA, address tokenB) external returns (address pair);
}

/// Receives every pool's 1% fee (in USDC) and shares it out (NeuriioFees).
interface IFeeVault {
    function notifyPoolFee(address token) external;
}

/// Owner side of our V2 factory (src/swap/v2/UniswapV2Factory.sol); `feeToSetter` is the owner.
interface ISwapFactoryAdmin is ISwapFactory {
    function feeToSetter() external view returns (address);
    function registry() external view returns (address);
    function setRegistry(address registry) external;
    function setFeeVault(address feeVault) external;
}
