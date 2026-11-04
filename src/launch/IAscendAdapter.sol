// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice The one place NeuriioLauncher touches Ascend. Ascend hasn't shared its addresses or ABIs yet, so its launch
/// call lives behind this: when they arrive, a small adapter contract implements it against their contracts and the owner
/// plugs it in with `NeuriioLauncher.setAdapter`. The launcher itself doesn't change.
/// An adapter MUST accept calls only from the launcher: anyone else calling it would launch around our identity rules.
interface IAscendAdapter {
    /// @notice Launches a token into Ascend's pool. Ascend's own settings (supply, quote token, opening price) and how
    /// the launch gets tagged as ours are the adapter's business.
    /// @param creators the verified wallets the deployer's share of the fees should reach: the creator, or an FTF's 4
    /// members (founder first), who share it equally
    /// @param name the token's name: at-sign + X handle, or the FTF's name
    /// @param symbol the ticker: the handle in caps, or the FTF's ticker
    /// @param launchData whatever else Ascend's launch needs, as signed into the pass by our backend
    /// @return token the new token
    /// @return pool its pool's identifier on Ascend (a Uniswap v4 PoolId, or whatever Ascend uses)
    function launch(
        address[] calldata creators,
        string calldata name,
        string calldata symbol,
        bytes calldata launchData
    ) external returns (address token, bytes32 pool);

    /// @notice The creator's first buy, right after the launch. The launcher has already sent this adapter `quoteIn` USDC.
    /// Buys `token` in Ascend's pool at market and sends the tokens to `buyer`, plus any USDC it didn't use. The launcher
    /// checks that `buyer` received at least their minimum.
    function firstBuy(address token, bytes32 pool, address buyer, uint256 quoteIn) external;
}
