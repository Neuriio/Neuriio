// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {NeuriioPad, ICurveFeeVault} from "../../src/launch/NeuriioPad.sol";
import {NeuriioRegistry} from "../../src/launch/NeuriioRegistry.sol";
import {ISwapFactory} from "../../src/swap/interfaces.sol";
import {NeuriioBase} from "../Base.t.sol";

/// Launch passes: the digests match EIP-712 as wallets/viem compute it, and a pass works once, for its holder, on its
/// pad, on its chain, from the current signer only, in its one canonical signature form.
contract AuditSignaturesTest is NeuriioBase {
    uint256 constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141; // secp256k1 order

    function _domainJson(address verifying) internal view returns (string memory) {
        return string.concat(
            '"domain":{"name":"Neuriio Launchpad","version":"1","chainId":',
            vm.toString(block.chainid),
            ',"verifyingContract":"',
            vm.toString(verifying),
            '"}'
        );
    }

    string constant DOMAIN_TYPE =
        '"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}]';

    /// `hashLaunchPass` equals the eth_signTypedData_v4 digest of the backend's types (launchPass.ts).
    function test_Audit_launchPassDigestIsStandardEip712() public view {
        NeuriioPad.LaunchPass memory p = _pass(alice, 1234567890123, "Some_Handle");
        string memory json = string.concat(
            '{"types":{',
            DOMAIN_TYPE,
            ',"LaunchPass":[{"name":"creator","type":"address"},{"name":"xUserId","type":"uint64"},{"name":"handle","type":"string"},{"name":"category","type":"uint8"},{"name":"profileHash","type":"bytes32"},{"name":"deadline","type":"uint256"}]},"primaryType":"LaunchPass",',
            _domainJson(address(pad)),
            ',"message":{"creator":"',
            vm.toString(p.creator),
            '","xUserId":',
            vm.toString(uint256(p.xUserId)),
            ',"handle":"Some_Handle","category":0,"profileHash":"',
            vm.toString(p.profileHash),
            '","deadline":',
            vm.toString(p.deadline),
            "}}"
        );
        assertEq(pad.hashLaunchPass(p), vm.eip712HashTypedData(json));
    }

    /// `hashFtfPass` (fixed-size arrays hashed with abi.encodePacked, i.e. each element padded to 32 bytes) equals the
    /// eth_signTypedData_v4 digest of the backend's types, so FTF passes signed by viem verify on-chain.
    function test_Audit_ftfPassDigestIsStandardEip712() public {
        NeuriioPad.FtfPass memory p = _ftfPass("Degen Den", "DEGEN");
        string memory members;
        string memory ids;
        for (uint256 i; i < 4; ++i) {
            string memory sep = i == 0 ? "" : ",";
            members = string.concat(members, sep, '"', vm.toString(p.members[i]), '"');
            ids = string.concat(ids, sep, vm.toString(uint256(p.memberXIds[i])));
        }
        string memory json = string.concat(
            '{"types":{',
            DOMAIN_TYPE,
            ',"FtfPass":[{"name":"founder","type":"address"},{"name":"name","type":"string"},{"name":"ticker","type":"string"},{"name":"memberXIds","type":"uint64[4]"},{"name":"members","type":"address[4]"},{"name":"profileHash","type":"bytes32"},{"name":"deadline","type":"uint256"}]},"primaryType":"FtfPass",',
            _domainJson(address(pad)),
            ',"message":{"founder":"',
            vm.toString(p.founder),
            '","name":"Degen Den","ticker":"DEGEN","memberXIds":[',
            ids,
            '],"members":[',
            members,
            '],"profileHash":"',
            vm.toString(p.profileHash),
            '","deadline":',
            vm.toString(p.deadline),
            "}}"
        );
        assertEq(pad.hashFtfPass(p), vm.eip712HashTypedData(json));
    }

    /// The other signature of the same pass (s -> n - s, v flipped) and the 64-byte compact form are refused, so each
    /// pass has exactly one valid signature (nothing relies on that, but it rules out malleability tricks).
    function test_Audit_malleatedAndCompactSignaturesRefused() public {
        NeuriioPad.LaunchPass memory p = _pass(alice, 77, "alice");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, pad.hashLaunchPass(p));
        bytes32 highS = bytes32(N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        vm.startPrank(alice);
        usdc.approve(address(pad), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        pad.launch(p, abi.encodePacked(r, highS, flippedV), 0, 0);
        (bytes32 cr, bytes32 vs) = vm.signCompact(signerPk, pad.hashLaunchPass(p));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 64));
        pad.launch(p, abi.encodePacked(cr, vs), 0, 0);
        pad.launch(p, abi.encodePacked(r, s, v), 0, 0); // the canonical one works, once
        vm.expectRevert(NeuriioRegistry.AlreadyLaunched.selector);
        pad.launch(p, abi.encodePacked(r, s, v), 0, 0);
        vm.stopPrank();
    }

    /// A pass signed for one pad doesn't verify on another pad version, nor on another chain, nor after the signer
    /// is rotated (rotation voids every outstanding pass at once).
    function test_Audit_passBoundToPadChainAndSigner() public {
        NeuriioPad pad2 = new NeuriioPad(
            owner,
            ISwapFactory(address(factory)),
            IERC20(address(usdc)),
            VQ,
            100,
            signer,
            ICurveFeeVault(address(vault)),
            registry
        );
        vm.prank(owner);
        registry.setLaunchpad(address(pad2), true);
        NeuriioPad.LaunchPass memory p = _pass(alice, 88, "alice");
        bytes memory sig = _sign(p, signerPk); // for `pad`
        vm.startPrank(alice);
        vm.expectRevert(NeuriioPad.InvalidPass.selector);
        pad2.launch(p, sig, 0, 0);
        uint256 home = block.chainid;
        vm.chainId(home + 1);
        vm.expectRevert(NeuriioPad.InvalidPass.selector);
        pad.launch(p, sig, 0, 0);
        vm.chainId(home);
        vm.stopPrank();
        vm.prank(owner);
        pad.setLaunchSigner(vm.addr(0xB0B));
        vm.prank(alice);
        vm.expectRevert(NeuriioPad.InvalidPass.selector);
        pad.launch(p, sig, 0, 0);
    }

    /// Two valid FTF passes for the same ticker (if the backend ever signed both): whoever sends first gets it, the
    /// other group's launch reverts and they need a new pass.
    function test_Audit_ftfTickerRaceFirstComeFirstServed() public {
        NeuriioPad.FtfPass memory first = _ftfPass("Group One", "SAME");
        _launchFtf(first, 0);
        NeuriioPad.FtfPass memory second = first;
        address[4] memory others;
        uint64[4] memory otherIds;
        for (uint256 i; i < 4; ++i) {
            others[i] = makeAddr(string.concat("other", vm.toString(i)));
            otherIds[i] = uint64(8_001 + i);
        }
        (second.founder, second.members, second.memberXIds, second.name) = (others[0], others, otherIds, "Group Two");
        bytes memory sig = _signFtf(second, signerPk);
        vm.prank(others[0]);
        vm.expectRevert(NeuriioRegistry.TickerTaken.selector);
        pad.launchFtf(second, sig, 0, 0);
    }
}
