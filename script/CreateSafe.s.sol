// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";

/// Safe v1.3.0 (Safe's canonical deployment: the same addresses and code on every chain).
interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function isOwner(address owner) external view returns (bool);
    function VERSION() external view returns (string memory);
    function nonce() external view returns (uint256);
    function approveHash(bytes32 hashToApprove) external;
    function approvedHashes(address owner, bytes32 hash) external view returns (uint256);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// Safe's canonical v1.3.0 contracts, checked against their code on Ethereum mainnet before anything uses them.
abstract contract SafeContracts is Script {
    address internal constant SAFE_L2 = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E; // GnosisSafeL2 (emits events)
    address internal constant SAFE_FACTORY = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2; // GnosisSafeProxyFactory
    address internal constant SAFE_FALLBACK = 0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4; // CompatibilityFallbackHandler
    // keccak256 of each one's runtime code on Ethereum mainnet (2026-10-22); Elysium testnet's copies match
    bytes32 internal constant SAFE_L2_CODEHASH = 0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f;
    bytes32 internal constant SAFE_FACTORY_CODEHASH =
        0x337d7f54be11b6ed55fef7b667ea5488db53db8320a05d1146aa4bd169a39a9b;
    bytes32 internal constant SAFE_FALLBACK_CODEHASH =
        0x03e69f7ce809e81687c69b19a7d7cca45b6d551ffdec73d9bb87178476de1abf;

    /// Reverts unless the contracts at Safe's addresses are byte-identical to Safe's own.
    function checkSafeContracts() public view {
        require(SAFE_L2.codehash == SAFE_L2_CODEHASH, "not Safe's v1.3.0 code: GnosisSafeL2");
        require(SAFE_FACTORY.codehash == SAFE_FACTORY_CODEHASH, "not Safe's v1.3.0 code: proxy factory");
        require(SAFE_FALLBACK.codehash == SAFE_FALLBACK_CODEHASH, "not Safe's v1.3.0 code: fallback handler");
    }
}

/// The Neuriio Safe: an M-of-N Safe (2-of-3 by default) from Safe's canonical v1.3.0 contracts. Whoever sends this only
/// pays the gas: the Safe's powers are its owners' alone. The address depends on the owners, threshold and SALT_NONCE,
/// so the same inputs make the same Safe address on every chain that has Safe's canonical contracts.
///   forge script script/CreateSafe.s.sol --rpc-url elysium_testnet --broadcast --account <any funded wallet>
/// env: OWNERS (comma list of the signers' wallet addresses), THRESHOLD (default 2), SALT_NONCE (default 0)
contract CreateSafe is SafeContracts {
    function run() external returns (address safe) {
        address[] memory owners = vm.envAddress("OWNERS", ",");
        uint256 threshold = vm.envOr("THRESHOLD", uint256(2));
        uint256 saltNonce = vm.envOr("SALT_NONCE", uint256(0));
        checkSafeContracts();
        require(threshold >= 2 && owners.length >= threshold, "need at least 2 of the owners to approve");
        for (uint256 i; i < owners.length; ++i) {
            require(owners[i] != address(0) && owners[i].code.length == 0, "an owner isn't a plain wallet");
            for (uint256 j; j < i; ++j) {
                require(owners[i] != owners[j], "the same owner twice");
            }
        }
        bytes memory init = abi.encodeCall(
            ISafe.setup, (owners, threshold, address(0), "", SAFE_FALLBACK, address(0), 0, payable(address(0)))
        );
        vm.startBroadcast();
        safe = ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_L2, init, saltNonce);
        vm.stopBroadcast();

        // read it back
        require(address(uint160(uint256(vm.load(safe, 0)))) == SAFE_L2, "the Safe doesn't run Safe's code");
        require(ISafe(safe).getThreshold() == threshold, "threshold");
        require(ISafe(safe).getOwners().length == owners.length, "owner count");
        for (uint256 i; i < owners.length; ++i) {
            require(ISafe(safe).isOwner(owners[i]), "an owner is missing");
        }
        console.log("Safe:", safe);
        console.log("version:", ISafe(safe).VERSION());
        console.log("threshold:", threshold, "of", owners.length);
    }
}
