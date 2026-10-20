// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice $NEURIIO, the platform token. Supply starts at zero and is hard-capped at 1B (`MAX_SUPPLY`): no mint can ever
/// go past it. The only way it's created is by staking graduated X tokens: the `minter` (NeuriioMinter) mints it to their
/// stakers as they earn fees. No pre-mint, no team or investor share. Stake it in NeuriioStaking (it deploys this token
/// and is pre-approved for every holder, so staking needs no approval transaction) to earn its share of every fee.
/// It can't be sent between wallets: until the owner opens transfers (`enableTransfers`, once and for good), the only
/// moves are mints and NeuriioStaking's own stake / unstake. The owner sets the minter, until `lockMinter()` fixes it for
/// good.
contract NeuriioPlatformToken is ERC20, Ownable2Step {
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;

    address public immutable staking;
    address public minter;
    bool public transferable;
    bool public minterLocked;

    event MinterSet(address minter);
    event MinterLocked();
    event TransfersEnabled();

    error NotMinter();
    error NotTransferable();
    error SupplyCapReached();
    error MinterIsLocked();

    constructor(address owner_) ERC20("Neuriio", "NEURIIO") Ownable(owner_) {
        staking = msg.sender;
    }

    /// @notice Mints `amount` (the minter only). Never past MAX_SUPPLY.
    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter();
        if (totalSupply() + amount > MAX_SUPPLY) revert SupplyCapReached();
        _mint(to, amount);
    }

    /// NeuriioStaking may always move holders' $NEURIIO (it only ever pulls from whoever is staking).
    function allowance(address owner_, address spender) public view override returns (uint256) {
        return spender == staking ? type(uint256).max : super.allowance(owner_, spender);
    }

    // ------------------------------------------------------------------ owner

    function setMinter(address minter_) external onlyOwner {
        if (minterLocked) revert MinterIsLocked();
        minter = minter_;
        emit MinterSet(minter_);
    }

    /// @notice Fixes the minter forever (before mainnet).
    function lockMinter() external onlyOwner {
        minterLocked = true;
        emit MinterLocked();
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
