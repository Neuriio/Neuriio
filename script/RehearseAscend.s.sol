// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAscendAdapter} from "../src/launch/IAscendAdapter.sol";
import {NeuriioLauncher} from "../src/launch/NeuriioLauncher.sol";
import {NeuriioTokenStaking} from "../src/stake/NeuriioTokenStaking.sol";
import {MockAscend, MockAscendAdapter, RehearsalUSDC} from "../test/mocks/MockAscend.sol";

/// The steps of script/rehearse-ascend.sh around the real deploy (script/DeployAscend.s.sol), on a local fork of Elysium
/// testnet with the stand-in Ascend (test/mocks/MockAscend.sol). Each step is one `--sig`; the shell script passes env.
contract RehearseAscend is Script {
    bytes32 internal constant SALT = bytes32("rehearsal");

    /// The stand-ins: 6-decimal USDC and Ascend.  env: ASCEND_WALLET
    function mocks() external {
        vm.startBroadcast();
        RehearsalUSDC usdc = new RehearsalUSDC();
        MockAscend ascend = new MockAscend(IERC20(address(usdc)), vm.envAddress("ASCEND_WALLET"));
        vm.stopBroadcast();
        console.log("USDC:", address(usdc));
        console.log("ASCEND:", address(ascend));
    }

    /// The adapter, deployed by anyone; plugging it in is the timelock's.  env: LAUNCHER, ASCEND, FEE_WALLET
    function adapter() external {
        vm.startBroadcast();
        MockAscendAdapter a = new MockAscendAdapter(
            vm.envAddress("LAUNCHER"), MockAscend(vm.envAddress("ASCEND")), vm.envAddress("FEE_WALLET")
        );
        vm.stopBroadcast();
        console.log("ADAPTER:", address(a));
    }

    /// Calldata for the Safe: timelock.schedule / timelock.execute of launcher.setAdapter(ADAPTER).  env: LAUNCHER, ADAPTER, TIMELOCK
    function scheduleData() external view {
        TimelockController t = TimelockController(payable(vm.envAddress("TIMELOCK")));
        console.logBytes(abi.encodeCall(t.schedule, (_target(), 0, _setAdapter(), bytes32(0), SALT, t.getMinDelay())));
    }

    function executeData() external view {
        TimelockController t = TimelockController(payable(vm.envAddress("TIMELOCK")));
        console.logBytes(abi.encodeCall(t.execute, (_target(), 0, _setAdapter(), bytes32(0), SALT)));
    }

    /// A launch with a signed pass and a first buy, a staker, a trader buying and selling. Checks exactly 0.5% of every
    /// trade's USDC side is waiting as our builder fee. The fee router (keeper/rehearse-router.mjs) collects and pays it next.
    /// env: LAUNCHER, STAKING, USDC, ASCEND, SIGNER_PK, CREATOR_PK, STAKER_PK, TRADER_PK, FEE_WALLET_PK
    function trade() external {
        RehearsalUSDC usdc = RehearsalUSDC(vm.envAddress("USDC"));

        (address token, bytes32 pool) = _launchStep(usdc); // 100 USDC first buy
        _stakeStep(usdc, token, pool); // 500 USDC
        uint256 usdcSide = 100e6 + 500e6 + _tradeStep(usdc, token, pool);

        // our 0.5% is waiting for this token's escrow, as on Ascend
        uint256 fees = MockAscend(vm.envAddress("ASCEND")).accruedFees(pool);
        uint256 expected = (usdcSide * 50) / 10_000;
        console.log("builder fee waiting for the escrow (USDC base units):", fees);
        console.log("0.5% of all trades (USDC base units):  ", expected);
        require(fees + 5 >= expected && fees <= expected + 5, "fees: not 0.5%"); // each fee rounds down
    }

    /// The creator launches the "rehearsal" handle with a signed pass and a 100 USDC first buy.
    function _launchStep(RehearsalUSDC usdc) internal returns (address token, bytes32 pool) {
        NeuriioLauncher launcher = NeuriioLauncher(vm.envAddress("LAUNCHER"));
        uint256 creatorPk = vm.envUint("CREATOR_PK");
        address creator = vm.addr(creatorPk);
        NeuriioLauncher.LaunchPass memory p = NeuriioLauncher.LaunchPass(
            creator, 424242, "rehearsal", 1, keccak256("profile"), "", block.timestamp + 1 hours
        );
        bytes memory sig = _signPass(launcher, p, vm.envUint("SIGNER_PK"));
        vm.startBroadcast(creatorPk);
        usdc.mint(creator, 100e6);
        usdc.approve(address(launcher), 100e6);
        token = launcher.launch(p, sig, 100e6, 1);
        vm.stopBroadcast();
        pool = launcher.launchOf(token).pool;
        console.log("TOKEN:", token);
        console.log("creator's first buy, tokens:", IERC20(token).balanceOf(creator) / 1e18);
        require(IERC20(token).balanceOf(creator) > 0, "first buy: no tokens");
        require(launcher.isLaunched(token) && launcher.creatorOf(token) == creator, "launch: not recorded");
    }

    /// The staker buys with 500 USDC and stakes it all.
    function _stakeStep(RehearsalUSDC usdc, address token, bytes32 pool) internal {
        NeuriioTokenStaking staking = NeuriioTokenStaking(vm.envAddress("STAKING"));
        MockAscend ascend = MockAscend(vm.envAddress("ASCEND"));
        uint256 stakerPk = vm.envUint("STAKER_PK");
        address staker = vm.addr(stakerPk);
        vm.startBroadcast(stakerPk);
        usdc.mint(staker, 500e6);
        usdc.approve(address(ascend), 500e6);
        uint256 got = ascend.buy(pool, 500e6, 1, staker);
        IERC20(token).approve(address(staking), got);
        staking.stake(token, got);
        vm.stopBroadcast();
        require(staking.stakedOf(staker, token) == got, "stake: not recorded");
        console.log("staked, tokens:", got / 1e18);
    }

    /// A trader buys with 2,000 USDC and sells half. Returns the two trades' USDC side (the sell's is before its 1.5%).
    function _tradeStep(RehearsalUSDC usdc, address token, bytes32 pool) internal returns (uint256) {
        MockAscend ascend = MockAscend(vm.envAddress("ASCEND"));
        uint256 traderPk = vm.envUint("TRADER_PK");
        address trader = vm.addr(traderPk);
        vm.startBroadcast(traderPk);
        usdc.mint(trader, 2_000e6);
        usdc.approve(address(ascend), 2_000e6);
        uint256 bought = ascend.buy(pool, 2_000e6, 1, trader);
        IERC20(token).approve(address(ascend), bought / 2);
        uint256 out = ascend.sell(pool, bought / 2, 1, trader);
        vm.stopBroadcast();
        return 2_000e6 + (out * 10_000) / 9_850;
    }

    function _signPass(NeuriioLauncher launcher, NeuriioLauncher.LaunchPass memory p, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, launcher.hashLaunchPass(p));
        return abi.encodePacked(r, s, v);
    }

    /// After the 1-hour drip: the staker, the only one staking, claims and gets the stakers' whole 40% of the fees.
    /// env: STAKING, USDC, STAKER_PK, TOKEN, FEES
    function claim() external {
        NeuriioTokenStaking staking = NeuriioTokenStaking(vm.envAddress("STAKING"));
        IERC20 usdc = IERC20(vm.envAddress("USDC"));
        address token = vm.envAddress("TOKEN");
        uint256 stakerPk = vm.envUint("STAKER_PK");
        address staker = vm.addr(stakerPk);
        uint256 earned = staking.earned(staker, token);
        address[] memory tokens = new address[](1);
        tokens[0] = token;
        uint256 before = usdc.balanceOf(staker);
        vm.startBroadcast(stakerPk);
        staking.claim(tokens, staker);
        vm.stopBroadcast();
        uint256 paid = usdc.balanceOf(staker) - before;
        console.log("staker claimed (USDC base units):", paid);
        require(paid == earned && paid + 4 >= (vm.envUint("FEES") * 40) / 100, "claim: short of 40% of the fees");
    }

    /// The identity gate, simulated (nothing sent): the same X account can't launch twice, and a pass from the wrong key fails.
    /// env: LAUNCHER, SIGNER_PK, CREATOR_PK
    function gate() external {
        NeuriioLauncher launcher = NeuriioLauncher(vm.envAddress("LAUNCHER"));
        address creator = vm.addr(vm.envUint("CREATOR_PK"));
        NeuriioLauncher.LaunchPass memory again = NeuriioLauncher.LaunchPass(
            creator, 424242, "rehearsal2", 1, keccak256("profile"), "", block.timestamp + 1 hours
        );
        bytes memory sig = _signPass(launcher, again, vm.envUint("SIGNER_PK"));
        vm.prank(creator);
        try launcher.launch(again, sig, 0, 0) {
            revert("gate: a second launch from the same X account went through");
        } catch {
            console.log("second launch from the same X account: refused");
        }
        address other = address(0xBEEF);
        NeuriioLauncher.LaunchPass memory forged =
            NeuriioLauncher.LaunchPass(other, 777, "forged", 1, keccak256("profile"), "", block.timestamp + 1 hours);
        sig = _signPass(launcher, forged, 0xBAD);
        vm.prank(other);
        try launcher.launch(forged, sig, 0, 0) {
            revert("gate: a pass from the wrong key went through");
        } catch {
            console.log("pass signed by the wrong key: refused");
        }
    }

    function _target() internal view returns (address) {
        return vm.envAddress("LAUNCHER");
    }

    function _setAdapter() internal view returns (bytes memory) {
        return abi.encodeCall(NeuriioLauncher.setAdapter, (IAscendAdapter(vm.envAddress("ADAPTER"))));
    }
}
