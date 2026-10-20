// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {NeuriioPlatformToken} from "./NeuriioPlatformToken.sol";
import {NeuriioStaking} from "./NeuriioStaking.sol";

/// @notice Mints $NEURIIO, the only way it comes to exist (user, 2026-10-17): staking an X token earns that pool's
/// USDC fees, and every $1 of fees its stakers earn mints `mintRate` $NEURIIO (25) to them, through NeuriioStaking.
/// The rate is never above MAX_MINT_RATE (25 per $1: user, 2026-10-20) and decays with the platform's growth, in PAPER's
/// shape: flat until `flatUntil` ($1M) of total platform fees, then mintRate x (S / (S + h))^2, with h = platform fees
/// past `flatUntil` and S = `decayScale`. Minting stops at the token's 1B supply cap (the last mint is cut to what's
/// left). Every fee the NeuriioFees takes moves the curve on (curve fees too, though they mint nothing: nobody stakes a
/// token before it graduates). The owner approves the fee vaults that report and can tune the curve (never above the
/// max) until `freezeMintCurve()` locks it for good.
contract NeuriioMinter is Ownable2Step {
    uint256 public constant MAX_MINT_RATE = 25e18; // $NEURIIO-wei per $1: never more than 25

    NeuriioPlatformToken public immutable neuriio;
    NeuriioStaking public immutable staking;
    uint256 public immutable quoteUnit; // 1 USDC in base units ($1)

    uint256 public mintRate; // $NEURIIO-wei per $1 earned (25e18 = 25 $NEURIIO per $1)
    uint256 public flatUntil; // dollars x 1e18 of platform fees before the decay starts
    uint256 public decayScale; // dollars x 1e18: S in the decay
    bool public mintCurveFrozen;
    uint256 public totalFees; // dollars x 1e18 of platform fees so far: where the curve stands
    mapping(address vault => bool) public isVault;

    event Minted(address indexed token, uint256 earnedUsd, uint256 minted);
    event VaultSet(address indexed vault, bool allowed);
    event MintCurveSet(uint256 mintRate, uint256 flatUntil, uint256 decayScale);
    event MintCurveFrozen();

    error NotVault();
    error InvalidParams();
    error MintCurveIsFrozen();

    constructor(address owner_, NeuriioStaking staking_, uint256 mintRate_, uint256 flatUntil_, uint256 decayScale_)
        Ownable(owner_)
    {
        staking = staking_;
        neuriio = staking_.neuriio();
        quoteUnit = 10 ** IERC20Metadata(address(staking_.quote())).decimals();
        _setMintCurve(mintRate_, flatUntil_, decayScale_);
    }

    /// @notice A fee vault reports a fee of `fee` USDC on `token`, of which `toHolders` went to that token's stakers:
    /// mints their $NEURIIO at the current rate, then moves the curve on by the whole fee.
    function onFee(address token, uint256 fee, uint256 toHolders) external returns (uint256 minted) {
        if (!isVault[msg.sender]) revert NotVault();
        if (toHolders > 0) {
            uint256 earnedUsd = Math.mulDiv(toHolders, 1e18, quoteUnit);
            minted = Math.min(Math.mulDiv(earnedUsd, rateNow(), 1e18), neuriio.MAX_SUPPLY() - neuriio.totalSupply());
            if (minted > 0) {
                neuriio.mint(address(staking), minted);
                staking.notifyNeuriio(token, minted);
                emit Minted(token, earnedUsd, minted);
            }
        }
        totalFees += Math.mulDiv(fee, 1e18, quoteUnit);
    }

    /// @notice $NEURIIO minted per $1 earned right now ($NEURIIO-wei, so 25e18 = 25).
    function rateNow() public view returns (uint256) {
        uint256 done = totalFees;
        if (done < flatUntil) return mintRate;
        uint256 s = decayScale;
        if (s == 0) return 0;
        uint256 h = done - flatUntil;
        return Math.mulDiv(Math.mulDiv(mintRate, s, s + h), s, s + h);
    }

    // ------------------------------------------------------------------ owner

    function setVault(address vault, bool allowed) external onlyOwner {
        isVault[vault] = allowed;
        emit VaultSet(vault, allowed);
    }

    function setMintCurve(uint256 mintRate_, uint256 flatUntil_, uint256 decayScale_) external onlyOwner {
        if (mintCurveFrozen) revert MintCurveIsFrozen();
        _setMintCurve(mintRate_, flatUntil_, decayScale_);
    }

    /// @notice Locks the mint curve forever (before mainnet).
    function freezeMintCurve() external onlyOwner {
        mintCurveFrozen = true;
        emit MintCurveFrozen();
    }

    function _setMintCurve(uint256 mintRate_, uint256 flatUntil_, uint256 decayScale_) internal {
        if (mintRate_ > MAX_MINT_RATE) revert InvalidParams();
        mintRate = mintRate_;
        flatUntil = flatUntil_;
        decayScale = decayScale_;
        emit MintCurveSet(mintRate_, flatUntil_, decayScale_);
    }
}
