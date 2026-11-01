// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAscendAdapter} from "./IAscendAdapter.sol";

/// The launcher side the adapter reads: the USDC it deals in.
interface ILauncherQuote {
    function quote() external view returns (IERC20);
}

/// @notice The part of an adapter that doesn't depend on Ascend's contracts (user, 2026-11-01). Only the launcher can use it, so
/// nobody can launch around the identity rules, and after a buy it holds nothing: the tokens and any unused USDC go to the
/// buyer. The real adapter extends this with the two calls into Ascend, once its contracts are known, and handles the
/// deployer's fee share for the `creators` it's given.
abstract contract AscendAdapterBase is IAscendAdapter {
    using SafeERC20 for IERC20;

    address public immutable launcher;
    IERC20 public immutable quote; // USDC, the same as the launcher's

    error NotLauncher();

    modifier onlyLauncher() {
        if (msg.sender != launcher) revert NotLauncher();
        _;
    }

    constructor(address launcher_) {
        launcher = launcher_;
        quote = ILauncherQuote(launcher_).quote();
    }

    function launch(
        address[] calldata creators,
        string calldata name,
        string calldata symbol,
        bytes calldata launchData
    ) external onlyLauncher returns (address token, bytes32 pool) {
        return _launchOnAscend(creators, name, symbol, launchData);
    }

    /// The launcher has already sent this contract `quoteIn` USDC, and checks what reached the buyer afterwards. Anything else
    /// sitting here (a donation) goes to the buyer too, so nothing ever stays.
    function firstBuy(address token, bytes32 pool, address buyer, uint256 quoteIn) external onlyLauncher {
        _buyOnAscend(token, pool, quoteIn);
        IERC20(token).safeTransfer(buyer, IERC20(token).balanceOf(address(this)));
        uint256 unused = quote.balanceOf(address(this));
        if (unused > 0) quote.safeTransfer(buyer, unused);
    }

    /// Launches on Ascend and returns the token and its pool.
    function _launchOnAscend(
        address[] calldata creators,
        string calldata name,
        string calldata symbol,
        bytes calldata launchData
    ) internal virtual returns (address token, bytes32 pool);

    /// Buys `token` on Ascend with up to `quoteIn` of the USDC held here, leaving what it bought here. Approve Ascend only for
    /// what's being spent.
    function _buyOnAscend(address token, bytes32 pool, uint256 quoteIn) internal virtual;
}
