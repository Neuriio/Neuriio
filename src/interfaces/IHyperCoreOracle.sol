// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Adapter-agnostic view of HyperCore spot top-of-book, as seen from Elysium.
/// @dev Everything downstream (AMM pricing, arb logic, vault) depends only on this interface.
///      Implementations:
///        - KeeperHyperCoreOracle: keeper pushes HyperCore state (works today, incl. testnet).
///        - Native precompile adapter: wraps Elysium's HyperCore data precompile once the
///          ArbOS upgrade ships (~4 weeks after mainnet; ABI not yet published).
///
///      Units: prices are WAD (1e18) quote-token units per 1 whole base token.
///             sizes are WAD whole base tokens.
///      Markets are keyed by HyperCore spot pair index (API coin name "at-N"; HYPE/USDC is 1035 on testnet).
interface IHyperCoreOracle {
    struct Bbo {
        uint256 bid;
        uint256 ask;
        uint256 bidSz;
        uint256 askSz;
        /// HyperCore block the data was derived from (0 if the source can't provide it).
        uint64 coreBlock;
        /// HyperCore block time in milliseconds.
        uint64 coreTimeMs;
        /// Elysium L2 block at which this data became available on-chain.
        /// A live precompile read returns the current block; a push oracle returns the push block.
        uint64 l2Block;
    }

    /// @return book zeroed struct if the market has never been observed.
    function bbo(uint32 spotIndex) external view returns (Bbo memory book);
}
