// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAscendAdapter} from "../../src/launch/IAscendAdapter.sol";
import {NeuriioLauncher} from "../../src/launch/NeuriioLauncher.sol";

contract AuditToken is ERC20 {
    uint8 internal immutable _decimals;

    constructor(uint8 decimals_) ERC20("Audit", "AUD") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// An adapter that does what the test tells it to, right or wrong.
contract AuditAdapter is IAscendAdapter {
    enum Mode {
        Normal,
        RevertLaunch,
        RevertBuy,
        KeepUsdc,
        RefundHalf,
        PayNothing
    }

    address public constant POOL = address(0x900D);
    uint256 public constant TOKENS_PER_USDC_UNIT = 100;

    AuditToken public immutable usdc;
    Mode public mode;
    address public given; // the token launch returns, instead of a new one
    bytes public reenterOnLaunch;
    bytes public reenterOnBuy;
    address public target;
    address[] internal _creators;
    string public lastName;
    string public lastSymbol;
    bytes public lastData;

    constructor(AuditToken usdc_) {
        usdc = usdc_;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setGiven(address token) external {
        given = token;
    }

    function setReenter(address target_, bytes calldata onLaunch, bytes calldata onBuy) external {
        target = target_;
        reenterOnLaunch = onLaunch;
        reenterOnBuy = onBuy;
    }

    function creators() external view returns (address[] memory) {
        return _creators;
    }

    function launch(
        address[] calldata creators_,
        string calldata name,
        string calldata symbol,
        bytes calldata launchData
    ) external returns (address token, bytes32 pool) {
        if (mode == Mode.RevertLaunch) revert("ascend: launch failed");
        if (reenterOnLaunch.length > 0) _call(reenterOnLaunch);
        _creators = creators_;
        lastName = name;
        lastSymbol = symbol;
        lastData = launchData;
        token = given != address(0) ? given : address(new AuditToken(18));
        pool = keccak256(abi.encode("pool", token));
    }

    function firstBuy(address token, bytes32, address buyer, uint256 quoteIn) external {
        if (mode == Mode.RevertBuy) revert("ascend: buy failed");
        if (reenterOnBuy.length > 0) _call(reenterOnBuy);
        if (mode == Mode.KeepUsdc) return AuditToken(token).mint(buyer, quoteIn * TOKENS_PER_USDC_UNIT);
        uint256 refund = mode == Mode.RefundHalf ? quoteIn / 2 : 0;
        if (refund > 0) usdc.transfer(buyer, refund);
        usdc.transfer(POOL, quoteIn - refund);
        if (mode != Mode.PayNothing) AuditToken(token).mint(buyer, (quoteIn - refund) * TOKENS_PER_USDC_UNIT);
    }

    function _call(bytes memory data) internal {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

abstract contract AscendAuditBase is Test {
    NeuriioLauncher internal launcher;
    AuditAdapter internal adapter;
    AuditToken internal usdc;

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dan = makeAddr("dan");
    uint256 internal signerPk = 0xA11CE;
    bytes32 internal constant PROFILE = keccak256("profile");

    function setUp() public virtual {
        vm.warp(1_760_000_000);
        usdc = new AuditToken(6);
        launcher = new NeuriioLauncher(owner, usdc, vm.addr(signerPk), guardian);
        adapter = new AuditAdapter(usdc);
        vm.prank(owner);
        launcher.setAdapter(adapter);
    }

    function _pass(address creator, uint64 xId, string memory handle)
        internal
        view
        returns (NeuriioLauncher.LaunchPass memory)
    {
        return NeuriioLauncher.LaunchPass(creator, xId, handle, 1, PROFILE, "", block.timestamp + 15 minutes);
    }

    function _sign(NeuriioLauncher.LaunchPass memory p, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, launcher.hashLaunchPass(p));
        return abi.encodePacked(r, s, v);
    }

    function _ftfPass(string memory name, string memory ticker) internal view returns (NeuriioLauncher.FtfPass memory) {
        return NeuriioLauncher.FtfPass(
            alice,
            name,
            ticker,
            [uint64(1), 2, 3, 4],
            [alice, bob, carol, dan],
            PROFILE,
            "",
            block.timestamp + 15 minutes
        );
    }

    function _signFtf(NeuriioLauncher.FtfPass memory p, uint256 pk) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, launcher.hashFtfPass(p));
        return abi.encodePacked(r, s, v);
    }

    function _launch(address creator, uint64 xId, string memory handle) internal returns (address) {
        NeuriioLauncher.LaunchPass memory p = _pass(creator, xId, handle);
        bytes memory sig = _sign(p, signerPk);
        vm.prank(creator);
        return launcher.launch(p, sig, 0, 0);
    }

    function _launchFtf(string memory name, string memory ticker) internal returns (address) {
        NeuriioLauncher.FtfPass memory p = _ftfPass(name, ticker);
        bytes memory sig = _signFtf(p, signerPk);
        vm.prank(p.founder);
        return launcher.launchFtf(p, sig, 0, 0);
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(launcher), type(uint256).max);
    }
}
