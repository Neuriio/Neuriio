// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice $NEURIIO, the platform token. Supply starts at zero and the only way to get it is to lose on a trade: the
/// NeuriioRouter (the `minter`) mints it on a losing sell, like Papertrade's PAPER. No pre-mint, no team or investor
/// share. Stake it in NeuriioStaking (it deploys this token and is pre-approved for every holder, so staking needs no
/// approval transaction) to earn the protocol's cut of every fee; staking is a choice.
/// It can't be sent between wallets: until the owner opens transfers (`enableTransfers`, once and for good), the only
/// moves are mints and NeuriioStaking's own stake / unstake. The owner sets the minter (a new NeuriioRouter version).
contract NeuriioPlatformToken is ERC20, Ownable2Step {
    address public immutable staking;
    address public minter;
    bool public transferable;

    event MinterSet(address minter);
    event TransfersEnabled();

    error NotMinter();
    error NotTransferable();

    constructor(address owner_) ERC20("Neuriio", "NEURIIO") Ownable(owner_) {
        staking = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        _mint(to, amount);
    }

    /// NeuriioStaking may always move holders' $NEURIIO (it only ever pulls from whoever is staking).
    function allowance(address owner_, address spender) public view override returns (uint256) {
        return spender == staking ? type(uint256).max : super.allowance(owner_, spender);
    }

    // ------------------------------------------------------------------ owner

    function setMinter(address minter_) external onlyOwner {
        minter = minter_;
        emit MinterSet(minter_);
    }

    function enableTransfers() external onlyOwner {
        transferable = true;
        emit TransfersEnabled();
    }

    // ------------------------------------------------------------------ internals

    function _update(address from, address to, uint256 value) internal override {
        if (!transferable && from != address(0) && msg.sender != staking) revert NotTransferable();
        super._update(from, to, value);
    }
}
