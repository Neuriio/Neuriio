// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IFeeVault, ISwapCallee, ISwapFactory} from "./interfaces.sol";

/// @notice Constant-product pool (x * y = k), a Uniswap V2 pair ported to 0.8 with a 0.25% swap fee.
/// Graduated launch tokens live here (TOKEN/WHYPE) with their LP tokens burned. Traders get exactly V2's
/// output for a 0.25% fee; right after each swap the pair takes that fee out of the pool as WHYPE and sends it
/// to the factory's FeeVault (80% to the token's creator, 20% to the protocol). Removing it never takes k
/// below its pre-swap value, so liquidity only ever stays level or grows.
contract SwapPair is ERC20 {
    using SafeERC20 for IERC20;

    uint256 public constant MINIMUM_LIQUIDITY = 1_000;
    uint256 public constant FEE_BPS = 25;
    /// OZ's ERC20 can't mint to address(0), so the permanently locked minimum goes here.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable factory;
    address public token0;
    address public token1;
    address public whype; // the WHYPE side (fees are paid in it)

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast; // UQ112x112 * seconds, wraps (TWAP oracles use differences)
    uint256 public price1CumulativeLast;

    uint256 private unlocked = 1;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);
    event FeeTaken(address indexed vault, uint256 whypeAmount);

    error Locked();
    error Forbidden();
    error Overflow();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientOutputAmount();
    error InsufficientInputAmount();
    error InsufficientLiquidity();
    error InvalidTo();
    error K();

    modifier lock() {
        if (unlocked != 1) revert Locked();
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor() ERC20("Neuriio LP", "NLP") {
        factory = msg.sender;
    }

    function initialize(address token0_, address token1_) external {
        if (msg.sender != factory || token0 != address(0)) revert Forbidden();
        token0 = token0_;
        token1 = token1_;
        whype = ISwapFactory(factory).whype();
    }

    function getReserves() public view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    // ------------------------------------------------------------------ liquidity

    /// @notice Mint LP for tokens already transferred in (low-level; callers must send tokens first).
    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 r0, uint112 r1,) = getReserves();
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - r0;
        uint256 amount1 = balance1 - r1;

        uint256 supply = totalSupply();
        if (supply == 0) {
            liquidity = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(DEAD, MINIMUM_LIQUIDITY);
        } else {
            liquidity = Math.min(amount0 * supply / r0, amount1 * supply / r1);
        }
        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);

        _update(balance0, balance1, r0, r1);
        emit Mint(msg.sender, amount0, amount1);
    }

    /// @notice Burn LP tokens already transferred in; sends both tokens to `to`.
    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        (uint112 r0, uint112 r1,) = getReserves();
        address t0 = token0;
        address t1 = token1;
        uint256 balance0 = IERC20(t0).balanceOf(address(this));
        uint256 balance1 = IERC20(t1).balanceOf(address(this));
        uint256 liquidity = balanceOf(address(this));

        uint256 supply = totalSupply();
        amount0 = liquidity * balance0 / supply;
        amount1 = liquidity * balance1 / supply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();
        _burn(address(this), liquidity);
        IERC20(t0).safeTransfer(to, amount0);
        IERC20(t1).safeTransfer(to, amount1);

        _update(IERC20(t0).balanceOf(address(this)), IERC20(t1).balanceOf(address(this)), r0, r1);
        emit Burn(msg.sender, amount0, amount1, to);
    }

    // ------------------------------------------------------------------ swaps

    /// @notice Low-level swap: send the input first, ask for outputs; the 0.25%-fee k check enforces payment.
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external lock {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 r0, uint112 r1,) = getReserves();
        if (amount0Out >= r0 || amount1Out >= r1) revert InsufficientLiquidity();

        uint256 balance0;
        uint256 balance1;
        {
            address t0 = token0;
            address t1 = token1;
            if (to == t0 || to == t1) revert InvalidTo();
            if (amount0Out > 0) IERC20(t0).safeTransfer(to, amount0Out);
            if (amount1Out > 0) IERC20(t1).safeTransfer(to, amount1Out);
            if (data.length > 0) ISwapCallee(to).swapCall(msg.sender, amount0Out, amount1Out, data);
            balance0 = IERC20(t0).balanceOf(address(this));
            balance1 = IERC20(t1).balanceOf(address(this));
        }
        uint256 amount0In = balance0 > r0 - amount0Out ? balance0 - (r0 - amount0Out) : 0;
        uint256 amount1In = balance1 > r1 - amount1Out ? balance1 - (r1 - amount1Out) : 0;
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();
        {
            uint256 adjusted0 = balance0 * 10_000 - amount0In * FEE_BPS;
            uint256 adjusted1 = balance1 * 10_000 - amount1In * FEE_BPS;
            if (adjusted0 * adjusted1 < uint256(r0) * r1 * 1e8) revert K();
        }
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);

        (balance0, balance1) = _takeFee(balance0, balance1, amount0In, amount1In);
        _update(balance0, balance1, r0, r1);
    }

    /// @notice Send any tokens above the reserves to `to`.
    function skim(address to) external lock {
        address t0 = token0;
        address t1 = token1;
        IERC20(t0).safeTransfer(to, IERC20(t0).balanceOf(address(this)) - reserve0);
        IERC20(t1).safeTransfer(to, IERC20(t1).balanceOf(address(this)) - reserve1);
    }

    /// @notice Set the reserves to the current balances.
    function sync() external lock {
        _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)), reserve0, reserve1);
    }

    // ------------------------------------------------------------------ internals

    function _update(uint256 balance0, uint256 balance1, uint112 r0, uint112 r1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert Overflow();
        uint32 now32 = uint32(block.timestamp); // wraps in 2106, as in V2
        unchecked {
            uint32 elapsed = now32 - blockTimestampLast;
            if (elapsed > 0 && r0 != 0 && r1 != 0) {
                price0CumulativeLast += (uint256(r1) << 112) / r0 * elapsed;
                price1CumulativeLast += (uint256(r0) << 112) / r1 * elapsed;
            }
        }
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = now32;
        emit Sync(reserve0, reserve1);
    }

    /// Moves the 0.25% fee out of the pool as WHYPE, to the FeeVault. With X = token balance, Y = WHYPE balance,
    /// ft/fh = the fee on the token/WHYPE input: the k check above guarantees (X - ft)(Y - fh) >= k_before; we
    /// remove fh + ft's value at the post-swap price, leaving X * Y'' >= (X - ft)(Y - fh) >= k_before.
    function _takeFee(uint256 balance0, uint256 balance1, uint256 amount0In, uint256 amount1In)
        private
        returns (uint256, uint256)
    {
        address vault = ISwapFactory(factory).feeVault();
        if (vault == address(0)) return (balance0, balance1); // no vault: the fee stays in the pool, like V2
        bool whypeIs0 = whype == token0;
        (uint256 x, uint256 y, uint256 tokenIn, uint256 whypeIn) =
            whypeIs0 ? (balance1, balance0, amount1In, amount0In) : (balance0, balance1, amount0In, amount1In);
        uint256 fh = whypeIn * FEE_BPS / 10_000;
        uint256 ft = tokenIn * FEE_BPS / 10_000;
        uint256 fee = fh + ft * (y - fh) / x;
        if (fee == 0) return (balance0, balance1);
        IERC20(whype).safeTransfer(vault, fee);
        IFeeVault(vault).notifyPoolFee(whypeIs0 ? token1 : token0);
        emit FeeTaken(vault, fee);
        return whypeIs0 ? (balance0 - fee, balance1) : (balance0, balance1 - fee);
    }
}
