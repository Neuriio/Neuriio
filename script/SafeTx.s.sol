// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console} from "forge-std/Script.sol";
import {ISafe, SafeContracts} from "./CreateSafe.s.sol";

/// One call from the Safe (TO, DATA), without Safe's website (it doesn't list Elysium). Signers approve on-chain, each
/// from their own wallet, so hardware wallets work and nobody shares a key:
///   1. hash:    forge script script/SafeTx.s.sol --sig "hash()" --rpc-url <rpc>
///               -> the Safe transaction's hash at the Safe's current nonce, and the approveHash calldata
///   2. approve: each signer (THRESHOLD of them) sends that calldata to the Safe, e.g.
///               cast send <SAFE> "approveHash(bytes32)" <hash> --ledger --rpc-url <rpc>
///   3. exec:    forge script script/SafeTx.s.sol --sig "exec()" --rpc-url <rpc> --broadcast --account <any funded wallet>
///               (checks that enough owners approved this exact transaction first; whoever sends it only pays gas)
/// A Safe transaction is one-shot: the hash includes the Safe's nonce, which every executed transaction moves on.
/// env: SAFE, TO, DATA (hex calldata)
contract SafeTx is SafeContracts {
    function hash() public view returns (bytes32 h) {
        (ISafe safe, address to, bytes memory data) = _env();
        uint256 n = safe.nonce();
        h = _hash(safe, to, data, n);
        console.log("Safe transaction, nonce %s, to %s, hash:", n, to);
        console.logBytes32(h);
        console.log("each signer sends this calldata to the Safe (approveHash):");
        console.logBytes(abi.encodeCall(ISafe.approveHash, (h)));
    }

    function exec() external returns (bool ok) {
        (ISafe safe, address to, bytes memory data) = _env();
        bytes32 h = _hash(safe, to, data, safe.nonce());
        address[] memory owners = safe.getOwners();
        address[] memory approved = new address[](owners.length);
        uint256 n;
        for (uint256 i; i < owners.length; ++i) {
            if (safe.approvedHashes(owners[i], h) != 0) approved[n++] = owners[i];
        }
        require(n >= safe.getThreshold(), "not enough approvals for this exact transaction yet");
        // the Safe checks signatures in ascending owner order
        for (uint256 i; i < n; ++i) {
            for (uint256 j = i + 1; j < n; ++j) {
                if (approved[j] < approved[i]) (approved[i], approved[j]) = (approved[j], approved[i]);
            }
        }
        bytes memory sigs;
        for (uint256 i; i < n; ++i) {
            // a "pre-approved hash" signature: r = the owner, s = 0, v = 1
            sigs = abi.encodePacked(sigs, bytes32(uint256(uint160(approved[i]))), bytes32(0), uint8(1));
        }
        vm.startBroadcast();
        // safeTxGas = gasPrice = 0: if the call fails, the whole transaction reverts (nothing half-done)
        ok = safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sigs);
        vm.stopBroadcast();
        require(ok, "the Safe's call failed");
        console.log("executed; the Safe's nonce is now", safe.nonce());
    }

    function _env() internal view returns (ISafe safe, address to, bytes memory data) {
        checkSafeContracts();
        safe = ISafe(vm.envAddress("SAFE"));
        require(address(uint160(uint256(vm.load(address(safe), 0)))) == SAFE_L2, "SAFE doesn't run Safe's code");
        to = vm.envAddress("TO");
        data = vm.envBytes("DATA");
    }

    function _hash(ISafe safe, address to, bytes memory data, uint256 n) internal view returns (bytes32) {
        return safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), n);
    }
}
