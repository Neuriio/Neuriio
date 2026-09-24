// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHyperCoreOracle} from "../interfaces/IHyperCoreOracle.sol";
import {ElysiumBlock} from "./ElysiumBlock.sol";

/// @notice Safe read path for HyperCore prices. Every consumer (AMM, arb, vault) goes through
///         `read`, which enforces freshness and sanity so no strategy ever acts on stale data.
library HyperCoreReader {
    uint256 internal constant BPS = 10_000;

    struct Guard {
        /// Max age of the Core timestamp vs chain time. Chain time is floor-seconds, so the
        /// true bound is maxAgeMs + <1000ms; use maxL2BlockLag for tighter control.
        uint32 maxAgeMs;
        /// Max Elysium blocks since the data landed on-chain (0 = must be this block).
        uint32 maxL2BlockLag;
        /// Reject books wider than this (protects against thin/broken books).
        uint16 maxSpreadBps;
    }

    struct Quote {
        uint256 bid;
        uint256 ask;
        uint256 mid;
        uint256 spreadBps;
        uint256 bidSz;
        uint256 askSz;
        uint64 coreBlock;
        uint64 coreTimeMs;
    }

    error NoData(uint32 spotIndex);
    error CrossedBook(uint32 spotIndex, uint256 bid, uint256 ask);
    error StaleByTime(uint32 spotIndex, uint256 ageMs, uint256 maxAgeMs);
    error StaleByBlocks(uint32 spotIndex, uint256 lag, uint256 maxLag);
    error SpreadTooWide(uint32 spotIndex, uint256 spreadBps, uint256 maxSpreadBps);

    function read(IHyperCoreOracle oracle, uint32 spotIndex, Guard memory g) internal view returns (Quote memory q) {
        IHyperCoreOracle.Bbo memory b = oracle.bbo(spotIndex);
        if (b.coreTimeMs == 0 || b.bid == 0) revert NoData(spotIndex);
        if (b.ask <= b.bid) revert CrossedBook(spotIndex, b.bid, b.ask);

        uint256 age = ageMs(b.coreTimeMs);
        if (age > g.maxAgeMs) revert StaleByTime(spotIndex, age, g.maxAgeMs);

        uint64 nowBlock = ElysiumBlock.number();
        uint256 lag = nowBlock > b.l2Block ? nowBlock - b.l2Block : 0;
        if (lag > g.maxL2BlockLag) revert StaleByBlocks(spotIndex, lag, g.maxL2BlockLag);

        q.bid = b.bid;
        q.ask = b.ask;
        q.mid = (b.bid + b.ask) / 2;
        q.spreadBps = spreadBps(b.bid, b.ask);
        if (q.spreadBps > g.maxSpreadBps) revert SpreadTooWide(spotIndex, q.spreadBps, g.maxSpreadBps);
        q.bidSz = b.bidSz;
        q.askSz = b.askSz;
        q.coreBlock = b.coreBlock;
        q.coreTimeMs = b.coreTimeMs;
    }

    /// @dev Rounds up so the guard is conservative.
    function spreadBps(uint256 bid, uint256 ask) internal pure returns (uint256) {
        uint256 mid = (bid + ask) / 2;
        return ((ask - bid) * BPS + mid - 1) / mid;
    }

    function ageMs(uint64 coreTimeMs) internal view returns (uint256) {
        uint64 nowMs = ElysiumBlock.timestampMs();
        return nowMs > coreTimeMs ? nowMs - coreTimeMs : 0;
    }
}
