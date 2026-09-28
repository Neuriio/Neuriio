// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A launched token: plain ERC-20, fixed supply minted once to the launchpad. No owner, no mint,
/// no fees or transfer rules. Named after the creator (at-sign + X handle); its profile hash lives in the Launchpad.
contract LaunchToken is ERC20 {
    address public immutable launchpad;
    constructor(string memory name_, string memory symbol_, uint256 supply) ERC20(name_, symbol_) {
        launchpad = msg.sender;
        _mint(msg.sender, supply);
    }
}
