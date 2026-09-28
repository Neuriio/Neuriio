// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {SwapPair} from "./SwapPair.sol";

/// @notice Creates SwapPairs (CREATE2, V2-style addresses). Only the launchpad creates pairs, so nobody can
/// open a graduating token's pool first at a bad price. Every pair sends its 0.25% swap fee to `feeVault`.
contract SwapFactory is Ownable2Step {
    address public immutable whype;
    address public feeVault; // set once; creator 80% / protocol 20%
    address public launchpad; // set once

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256 count);
    event FeeVaultSet(address feeVault);
    event LaunchpadSet(address launchpad);

    error NotLaunchpad();
    error IdenticalTokens();
    error ZeroAddress();
    error PairExists();
    error AlreadySet();

    constructor(address owner_, address whype_) Ownable(owner_) {
        whype = whype_;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice keccak256 of the pair creation code, for computing pair addresses off-chain / in routers.
    function pairCodeHash() external pure returns (bytes32) {
        return keccak256(type(SwapPair).creationCode);
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        if (msg.sender != launchpad) revert NotLaunchpad();
        if (tokenA == tokenB) revert IdenticalTokens();
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert ZeroAddress();
        if (getPair[token0][token1] != address(0)) revert PairExists();

        pair = address(new SwapPair{salt: keccak256(abi.encodePacked(token0, token1))}());
        SwapPair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeVault(address feeVault_) external onlyOwner {
        if (feeVault != address(0)) revert AlreadySet();
        if (feeVault_ == address(0)) revert ZeroAddress();
        feeVault = feeVault_;
        emit FeeVaultSet(feeVault_);
    }

    function setLaunchpad(address launchpad_) external onlyOwner {
        if (launchpad != address(0)) revert AlreadySet();
        if (launchpad_ == address(0)) revert ZeroAddress();
        launchpad = launchpad_;
        emit LaunchpadSet(launchpad_);
    }
}
