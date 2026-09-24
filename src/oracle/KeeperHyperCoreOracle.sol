// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHyperCoreOracle} from "../interfaces/IHyperCoreOracle.sol";
import {ElysiumBlock} from "../libraries/ElysiumBlock.sol";

/// @notice Keeper-pushed HyperCore top-of-book. Bridges the gap until Elysium's native
///         HyperCore data precompile ships; trust = the configured updaters.
contract KeeperHyperCoreOracle is IHyperCoreOracle, Ownable2Step {
    using SafeCast for uint256;

    struct Update {
        uint32 spotIndex;
        uint256 bid;
        uint256 ask;
        uint256 bidSz;
        uint256 askSz;
        uint64 coreBlock;
        uint64 coreTimeMs;
    }

    struct Book {
        uint96 bid;
        uint96 ask;
        uint64 coreTimeMs;
        uint96 bidSz;
        uint96 askSz;
        uint64 coreBlock;
        uint64 l2Block;
    }

    /// @notice How far ahead of the chain clock a Core timestamp may be. Covers the 1s
    ///         resolution of `block.timestamp` plus clock skew.
    uint64 public maxFutureDriftMs;

    mapping(address => bool) public isUpdater;
    mapping(uint32 => Book) internal _books;

    event UpdaterSet(address indexed updater, bool allowed);
    event MaxFutureDriftSet(uint64 driftMs);
    event BboUpdated(uint32 indexed spotIndex, uint256 bid, uint256 ask, uint64 coreBlock, uint64 coreTimeMs);
    /// Out-of-order or duplicate update; skipped instead of reverting so one late entry
    /// can't sink a whole batch.
    event UpdateSkipped(uint32 indexed spotIndex, uint64 coreTimeMs, uint64 storedCoreTimeMs);

    error NotUpdater(address caller);
    error InvalidBook(uint32 spotIndex, uint256 bid, uint256 ask);
    error TimestampInFuture(uint32 spotIndex, uint64 coreTimeMs, uint64 chainTimeMs);

    constructor(address owner_, uint64 maxFutureDriftMs_) Ownable(owner_) {
        maxFutureDriftMs = maxFutureDriftMs_;
        emit MaxFutureDriftSet(maxFutureDriftMs_);
    }

    function setUpdater(address updater, bool allowed) external onlyOwner {
        isUpdater[updater] = allowed;
        emit UpdaterSet(updater, allowed);
    }

    function setMaxFutureDriftMs(uint64 driftMs) external onlyOwner {
        maxFutureDriftMs = driftMs;
        emit MaxFutureDriftSet(driftMs);
    }

    function push(Update[] calldata updates) external {
        if (!isUpdater[msg.sender]) revert NotUpdater(msg.sender);

        uint64 l2Block = ElysiumBlock.number();
        uint64 latestAllowedMs = ElysiumBlock.timestampMs() + 1000 + maxFutureDriftMs;

        for (uint256 i; i < updates.length; ++i) {
            Update calldata u = updates[i];
            if (u.bid == 0 || u.ask <= u.bid) revert InvalidBook(u.spotIndex, u.bid, u.ask);
            if (u.coreTimeMs > latestAllowedMs) {
                revert TimestampInFuture(u.spotIndex, u.coreTimeMs, ElysiumBlock.timestampMs());
            }

            Book storage b = _books[u.spotIndex];
            if (u.coreTimeMs <= b.coreTimeMs) {
                emit UpdateSkipped(u.spotIndex, u.coreTimeMs, b.coreTimeMs);
                continue;
            }

            _books[u.spotIndex] = Book({
                bid: u.bid.toUint96(),
                ask: u.ask.toUint96(),
                coreTimeMs: u.coreTimeMs,
                bidSz: u.bidSz.toUint96(),
                askSz: u.askSz.toUint96(),
                coreBlock: u.coreBlock,
                l2Block: l2Block
            });
            emit BboUpdated(u.spotIndex, u.bid, u.ask, u.coreBlock, u.coreTimeMs);
        }
    }

    function bbo(uint32 spotIndex) external view returns (Bbo memory book) {
        Book memory b = _books[spotIndex];
        book = Bbo({
            bid: b.bid,
            ask: b.ask,
            bidSz: b.bidSz,
            askSz: b.askSz,
            coreBlock: b.coreBlock,
            coreTimeMs: b.coreTimeMs,
            l2Block: b.l2Block
        });
    }
}
