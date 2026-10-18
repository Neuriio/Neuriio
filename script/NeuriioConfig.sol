// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";

/// Settings shared by the deploy scripts that create a NeuriioMinter.
abstract contract NeuriioConfig is Script {
    /// The $NEURIIO mint curve (owner-tunable until frozen; user, 2026-10-17): MINT_RATE $NEURIIO per $1 of fees earned
    /// by X-token stakers (default 100), FLAT_UNTIL dollars of total platform fees before the decay starts (default
    /// 1,000,000), DECAY_SCALE dollars (default 120,000,000, PAPER's).
    function _mintCurve() internal view returns (uint256 rate, uint256 flatUntil, uint256 decayScale) {
        rate = vm.envOr("MINT_RATE", uint256(100)) * 1e18;
        flatUntil = vm.envOr("FLAT_UNTIL", uint256(1_000_000)) * 1e18;
        decayScale = vm.envOr("DECAY_SCALE", uint256(120_000_000)) * 1e18;
    }
}
