// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice USDC for Elysium TESTNET only: 6 decimals like USDC, and only minters the owner approves (our faucet) can
/// mint, so test balances stay meaningful for points and leaderboards (the old tUSDC let anyone mint any amount).
/// Never deploy on mainnet: there the quote token is the bridged copy of HyperEVM's USDC.
contract TestUSDC is ERC20, Ownable2Step {
    mapping(address minter => bool) public isMinter;

    event MinterSet(address indexed minter, bool allowed);

    error NotMinter();

    constructor(address owner_) ERC20("Test USDC", "USDC") Ownable(owner_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (!isMinter[msg.sender]) revert NotMinter();
        _mint(to, amount);
    }

    function setMinter(address minter, bool allowed) external onlyOwner {
        isMinter[minter] = allowed;
        emit MinterSet(minter, allowed);
    }
}
