// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {NeuriioRegistry} from "../src/launch/NeuriioRegistry.sol";
import {NeuriioFees} from "../src/launch/NeuriioFees.sol";
import {NeuriioPad, ICurveFeeVault} from "../src/launch/NeuriioPad.sol";
import {NeuriioRouter} from "../src/swap/NeuriioRouter.sol";
import {NeuriioStaking} from "../src/stake/NeuriioStaking.sol";
import {NeuriioMinter} from "../src/stake/NeuriioMinter.sol";
import {NeuriioPlatformToken} from "../src/stake/NeuriioPlatformToken.sol";
import {ISwapFactory, ISwapFactoryAdmin} from "../src/swap/interfaces.sol";
import {NeuriioConfig} from "./NeuriioConfig.sol";

/// The owner side of our Uniswap V2 fork's factory that ISwapFactoryAdmin leaves out.
interface IV2FactoryOwner {
    function feeTo() external view returns (address);
    function setFeeToSetter(address feeToSetter) external;
}

/// MAINNET in one run: the whole stack on the REAL USDC (no TestUSDC, no faucet), wired, locked, and handed to a
/// TimelockController that only the Safe runs. When it ends, the deployer has no power left anywhere:
///   - deploys NeuriioRegistry, the V2 fork factory, NeuriioStaking (+ $NEURIIO), NeuriioMinter, NeuriioFees,
///     NeuriioRouter and NeuriioPad, and wires them (as DeployCore + DeployNeuriioPad do on testnet);
///   - sets the protocol wallets, the pad's guardian (the Safe: it can pause at once, nothing else) and any extra
///     reserved tickers; locks the minter's vaults, freezes the mint curve and locks $NEURIIO's minter;
///   - hands every owner power to the timelock (registry, pad, fees, minter, $NEURIIO, and the factory's
///     feeToSetter) and makes the Safe its only proposer / canceller / executor, with a TIMELOCK_DELAY delay, so every
///     admin change is public that long before it can happen;
///   - checks all of the above on-chain (`check`) and prints the addresses.
/// The timelock starts at a 0 delay with the deployer as its only proposer + executor, uses that once to accept the
/// ownerships, hand its roles to the Safe and set the real delay, all in one batch; test/DeployMainnet.t.sol runs it.
///   forge script script/DeployMainnet.s.sol --rpc-url <elysium mainnet> --broadcast --account <deployer keystore>
/// env (required): USDC (6 decimals), SAFE (a deployed multisig), TREASURY_WALLET, BUYBACK_WALLET, LAUNCH_SIGNER (a
///   new key, never the testnet one), VIRTUAL_QUOTE (USDC base units), TIMELOCK_DELAY (seconds: at least 1 day;
///   a testnet rehearsal may use 5 minutes);
/// optional: FEE_BPS (default 100), RESERVED_TICKERS (comma list, added to the registry's built-in ones), the mint curve
///   (NeuriioConfig), ALLOW_TESTNET=true (a rehearsal on the testnet chain).
contract DeployMainnet is NeuriioConfig {
    uint256 internal constant TESTNET_CHAIN_ID = 99_801;
    address internal constant TESTNET_LAUNCH_SIGNER = 0x25626586434fb2003d12957a1fC4B0fA5EA52886;

    struct Params {
        address usdc;
        address safe;
        address treasury;
        address buyback;
        address launchSigner;
        uint256 virtualQuote;
        uint16 feeBps;
        uint256 timelockDelay;
        uint256 mintRate;
        uint256 flatUntil;
        uint256 decayScale;
        string[] reservedTickers;
    }

    struct Deployment {
        NeuriioRegistry registry;
        ISwapFactoryAdmin factory;
        NeuriioStaking staking;
        NeuriioPlatformToken neuriio;
        NeuriioMinter minter;
        NeuriioFees vault;
        NeuriioRouter router;
        NeuriioPad pad;
        TimelockController timelock;
    }

    function run() external returns (Deployment memory d) {
        Params memory p = params();
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d = _deploy(p, deployer);
        vm.stopBroadcast();
        check(d, p, deployer);
        _log(d);
    }

    /// The settings from the environment, refused unless they look like mainnet.
    function params() public view returns (Params memory p) {
        p.usdc = vm.envAddress("USDC");
        p.safe = vm.envAddress("SAFE");
        p.treasury = vm.envAddress("TREASURY_WALLET");
        p.buyback = vm.envAddress("BUYBACK_WALLET");
        p.launchSigner = vm.envAddress("LAUNCH_SIGNER");
        p.virtualQuote = vm.envUint("VIRTUAL_QUOTE");
        p.feeBps = uint16(vm.envOr("FEE_BPS", uint256(100)));
        p.timelockDelay = vm.envUint("TIMELOCK_DELAY");
        (p.mintRate, p.flatUntil, p.decayScale) = _mintCurve();
        p.reservedTickers = vm.envOr("RESERVED_TICKERS", ",", new string[](0));

        bool rehearsal = block.chainid == TESTNET_CHAIN_ID;
        require(!rehearsal || vm.envOr("ALLOW_TESTNET", false), "testnet: set ALLOW_TESTNET");
        require(p.usdc.code.length > 0 && IERC20Metadata(p.usdc).decimals() == 6, "USDC: not a 6-decimal token");
        require(p.safe.code.length > 0, "SAFE: not a deployed multisig");
        require(p.treasury != address(0) && p.buyback != address(0), "protocol wallets missing");
        require(p.launchSigner != address(0) && p.launchSigner != TESTNET_LAUNCH_SIGNER, "LAUNCH_SIGNER: use a new key");
        // a rehearsal on the testnet chain may use minutes, to see a timelocked change through; mainnet: at least a day
        if (rehearsal) require(p.timelockDelay >= 5 minutes, "TIMELOCK_DELAY: at least 5 minutes");
        else require(p.timelockDelay >= 1 days, "TIMELOCK_DELAY: at least 1 day");
    }

    function _deploy(Params memory p, address deployer) internal returns (Deployment memory d) {
        // the core and the pad, owned by the deployer while it wires them
        d.registry = new NeuriioRegistry(deployer);
        d.factory = ISwapFactoryAdmin(deployCode("UniswapV2Factory.sol:UniswapV2Factory", abi.encode(deployer, p.usdc)));
        d.factory.setRegistry(address(d.registry));
        d.staking = new NeuriioStaking(ISwapFactory(address(d.factory)), IERC20(p.usdc), deployer);
        d.neuriio = d.staking.neuriio();
        d.minter = new NeuriioMinter(deployer, d.staking, p.mintRate, p.flatUntil, p.decayScale);
        d.neuriio.setMinter(address(d.minter));
        d.vault = new NeuriioFees(
            deployer, IERC20(p.usdc), ISwapFactory(address(d.factory)), d.registry, d.staking, d.minter
        );
        d.minter.setVault(address(d.vault), true);
        d.factory.setFeeVault(address(d.vault));
        d.router = new NeuriioRouter(d.registry, ISwapFactory(address(d.factory)));
        d.pad = new NeuriioPad(
            deployer,
            ISwapFactory(address(d.factory)),
            IERC20(p.usdc),
            p.virtualQuote,
            p.feeBps,
            p.launchSigner,
            ICurveFeeVault(address(d.vault)),
            d.registry
        );
        d.registry.setLaunchpad(address(d.pad), true);
        if (p.reservedTickers.length > 0) d.registry.setReservedTickers(p.reservedTickers, true);
        d.vault.setWallets(p.treasury, p.buyback);
        d.pad.setGuardian(p.safe);

        // locks: no new minting vault, no mint-curve change, no new $NEURIIO minter, ever
        d.minter.lockVaults();
        d.minter.freezeMintCurve();
        d.neuriio.lockMinter();

        // the timelock: 0 delay and the deployer as its only proposer / executor, for one batch
        address[] memory deployerOnly = new address[](1);
        deployerOnly[0] = deployer;
        d.timelock = new TimelockController(0, deployerOnly, deployerOnly, address(0));
        address[5] memory owned =
            [address(d.registry), address(d.pad), address(d.vault), address(d.minter), address(d.neuriio)];
        for (uint256 i; i < owned.length; ++i) {
            Ownable2Step(owned[i]).transferOwnership(address(d.timelock));
        }
        IV2FactoryOwner(address(d.factory)).setFeeToSetter(address(d.timelock)); // one step (V2's own)

        // the batch: accept every ownership, give the Safe every role, take the deployer's, set the real delay
        address[] memory targets = new address[](12);
        bytes[] memory payloads = new bytes[](12);
        for (uint256 i; i < owned.length; ++i) {
            (targets[i], payloads[i]) = (owned[i], abi.encodeCall(Ownable2Step.acceptOwnership, ()));
        }
        TimelockController t = d.timelock;
        bytes32[3] memory roles = [t.PROPOSER_ROLE(), t.CANCELLER_ROLE(), t.EXECUTOR_ROLE()];
        for (uint256 i; i < 3; ++i) {
            (targets[5 + i], payloads[5 + i]) =
            (address(t), abi.encodeCall(IAccessControl.grantRole, (roles[i], p.safe)));
            (targets[8 + i], payloads[8 + i]) =
            (address(t), abi.encodeCall(IAccessControl.revokeRole, (roles[i], deployer)));
        }
        (targets[11], payloads[11]) = (address(t), abi.encodeCall(TimelockController.updateDelay, (p.timelockDelay)));
        uint256[] memory values = new uint256[](12);
        bytes32 salt = keccak256("neuriio mainnet handover");
        t.scheduleBatch(targets, values, payloads, bytes32(0), salt, 0);
        t.executeBatch(targets, values, payloads, bytes32(0), salt);
    }

    /// Everything the deploy promises, read back on-chain; reverts on the first thing that's off.
    function check(Deployment memory d, Params memory p, address deployer) public view {
        address tl = address(d.timelock);
        address[5] memory owned =
            [address(d.registry), address(d.pad), address(d.vault), address(d.minter), address(d.neuriio)];
        for (uint256 i; i < owned.length; ++i) {
            require(Ownable2Step(owned[i]).owner() == tl, "an owner isn't the timelock");
            require(Ownable2Step(owned[i]).pendingOwner() == address(0), "an ownership is still pending");
        }
        require(d.factory.feeToSetter() == tl, "factory: feeToSetter isn't the timelock");
        require(IV2FactoryOwner(address(d.factory)).feeTo() == address(0), "factory: LP fee is on");
        require(d.factory.quote() == p.usdc && d.factory.feeVault() == address(d.vault), "factory: wiring");
        require(d.factory.registry() == address(d.registry), "factory: registry");

        require(d.registry.isLaunchpad(address(d.pad)), "registry: pad not approved");
        require(address(d.pad.feeVault()) == address(d.vault) && d.pad.launchSigner() == p.launchSigner, "pad: wiring");
        require(d.pad.guardian() == p.safe && !d.pad.paused(), "pad: guardian / paused");
        require(d.pad.feeBps() == p.feeBps && d.pad.virtualQuote() == p.virtualQuote, "pad: settings");
        require(address(d.router.factory()) == address(d.factory), "router: factory");
        require(address(d.router.registry()) == address(d.registry), "router: registry");
        require(d.vault.treasuryWallet() == p.treasury && d.vault.buybackWallet() == p.buyback, "fees: wallets");

        require(d.minter.isVault(address(d.vault)) && d.minter.vaultsLocked(), "minter: vaults");
        require(d.minter.mintCurveFrozen() && d.minter.mintRate() == p.mintRate, "minter: curve");
        require(d.neuriio.minter() == address(d.minter) && d.neuriio.minterLocked(), "neuriio: minter");

        TimelockController t = d.timelock;
        require(t.getMinDelay() == p.timelockDelay, "timelock: delay");
        bytes32[4] memory roles = [t.PROPOSER_ROLE(), t.CANCELLER_ROLE(), t.EXECUTOR_ROLE(), t.DEFAULT_ADMIN_ROLE()];
        for (uint256 i; i < 4; ++i) {
            require(!t.hasRole(roles[i], deployer), "timelock: the deployer kept a role");
            require(t.hasRole(roles[i], p.safe) == (i < 3), "timelock: the Safe's roles");
        }
        require(t.hasRole(roles[3], tl), "timelock: not self-administered");
    }

    function _log(Deployment memory d) internal pure {
        console.log("NeuriioRegistry:", address(d.registry));
        console.log("SwapFactory (UniswapV2Factory):", address(d.factory));
        console.log("NeuriioStaking:", address(d.staking));
        console.log("NeuriioPlatformToken:", address(d.neuriio));
        console.log("NeuriioMinter:", address(d.minter));
        console.log("NeuriioFees:", address(d.vault));
        console.log("NeuriioRouter:", address(d.router));
        console.log("NeuriioPad:", address(d.pad));
        console.log("TimelockController:", address(d.timelock));
    }
}
