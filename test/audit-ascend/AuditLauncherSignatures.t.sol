// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {NeuriioLauncher} from "../../src/launch/NeuriioLauncher.sol";
import {AscendAuditBase} from "./AscendAuditBase.sol";

/// Cantina risk 2 (EIP-712 and the backend signer): digests match what wallets and viem compute from the backend's types
/// (supabase/functions/_shared/launchPass.ts), and a pass works once, for its holder, on this launcher, on this chain, from the
/// current signer, before its deadline, in its one canonical signature form, on both launch paths.
contract AuditLauncherSignaturesTest is AscendAuditBase {
    uint256 constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141; // secp256k1 order
    string constant DOMAIN_TYPE =
        '"EIP712Domain":[{"name":"name","type":"string"},{"name":"version","type":"string"},{"name":"chainId","type":"uint256"},{"name":"verifyingContract","type":"address"}]';

    function _domainJson(address verifying) internal view returns (string memory) {
        return string.concat(
            '"domain":{"name":"Neuriio Launchpad","version":"1","chainId":',
            vm.toString(block.chainid),
            ',"verifyingContract":"',
            vm.toString(verifying),
            '"}'
        );
    }

    function test_launchPassDigestIsStandardEip712() public view {
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1234567890123, "Some_Handle");
        p.launchData = hex"c0ffee";
        string memory json = string.concat(
            '{"types":{',
            DOMAIN_TYPE,
            ',"LaunchPass":[{"name":"creator","type":"address"},{"name":"xUserId","type":"uint64"},{"name":"handle","type":"string"},{"name":"category","type":"uint8"},{"name":"profileHash","type":"bytes32"},{"name":"launchData","type":"bytes"},{"name":"deadline","type":"uint256"}]},"primaryType":"LaunchPass",',
            _domainJson(address(launcher)),
            ',"message":{"creator":"',
            vm.toString(p.creator),
            '","xUserId":',
            vm.toString(uint256(p.xUserId)),
            ',"handle":"Some_Handle","category":1,"profileHash":"',
            vm.toString(p.profileHash),
            '","launchData":"0xc0ffee","deadline":',
            vm.toString(p.deadline),
            "}}"
        );
        assertEq(launcher.hashLaunchPass(p), vm.eip712HashTypedData(json));
    }

    function test_ftfPassDigestIsStandardEip712() public view {
        NeuriioLauncher.FtfPass memory p = _ftfPass("Degen Den", "DEGEN");
        p.launchData = hex"c0ffee";
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
            ',"FtfPass":[{"name":"founder","type":"address"},{"name":"name","type":"string"},{"name":"ticker","type":"string"},{"name":"memberXIds","type":"uint64[4]"},{"name":"members","type":"address[4]"},{"name":"profileHash","type":"bytes32"},{"name":"launchData","type":"bytes"},{"name":"deadline","type":"uint256"}]},"primaryType":"FtfPass",',
            _domainJson(address(launcher)),
            ',"message":{"founder":"',
            vm.toString(p.founder),
            '","name":"Degen Den","ticker":"DEGEN","memberXIds":[',
            ids,
            '],"members":[',
            members,
            '],"profileHash":"',
            vm.toString(p.profileHash),
            '","launchData":"0xc0ffee","deadline":',
            vm.toString(p.deadline),
            "}}"
        );
        assertEq(launcher.hashFtfPass(p), vm.eip712HashTypedData(json));
    }

    function test_malleatedAndCompactSignaturesRefused() public {
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 77, "alice");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, launcher.hashLaunchPass(p));
        bytes32 highS = bytes32(N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        launcher.launch(p, abi.encodePacked(r, highS, flippedV), 0, 0);
        (bytes32 cr, bytes32 vs) = vm.signCompact(signerPk, launcher.hashLaunchPass(p));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 64));
        launcher.launch(p, abi.encodePacked(cr, vs), 0, 0);
        launcher.launch(p, abi.encodePacked(r, s, v), 0, 0); // the canonical one works, once
        vm.expectRevert(NeuriioLauncher.AlreadyLaunched.selector);
        launcher.launch(p, abi.encodePacked(r, s, v), 0, 0);
        vm.stopPrank();
    }

    function test_passBoundToLauncherChainAndSigner() public {
        NeuriioLauncher other = new NeuriioLauncher(owner, usdc, vm.addr(signerPk), guardian);
        vm.prank(owner);
        other.setAdapter(adapter);
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 88, "alice");
        bytes memory sig = _sign(p, signerPk);
        vm.startPrank(alice);
        vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
        other.launch(p, sig, 0, 0);
        uint256 home = block.chainid;
        vm.chainId(home + 1);
        vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
        launcher.launch(p, sig, 0, 0);
        vm.chainId(home);
        vm.stopPrank();
        vm.prank(owner);
        launcher.setLaunchSigner(vm.addr(0xB0B));
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
        launcher.launch(p, sig, 0, 0);
    }

    /// A personal pass's signature says nothing on the FTF path, and the other way round.
    function test_passTypesDontCross() public {
        NeuriioLauncher.FtfPass memory f = _ftfPass("Degen Den", "DEN");
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory personalSig = _sign(p, signerPk);
        bytes memory ftfSig = _signFtf(f, signerPk);
        vm.startPrank(alice);
        vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
        launcher.launchFtf(f, personalSig, 0, 0);
        vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
        launcher.launch(p, ftfSig, 0, 0);
        vm.stopPrank();
    }

    function test_deadlineEnforcedToTheSecondOnBothPaths() public {
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        NeuriioLauncher.FtfPass memory f = _ftfPass("Degen Den", "DEN");
        bytes memory sig = _sign(p, signerPk);
        bytes memory ftfSig = _signFtf(f, signerPk);
        vm.warp(p.deadline + 1);
        vm.startPrank(alice);
        vm.expectRevert(NeuriioLauncher.Expired.selector);
        launcher.launch(p, sig, 0, 0);
        vm.expectRevert(NeuriioLauncher.Expired.selector);
        launcher.launchFtf(f, ftfSig, 0, 0);
        vm.warp(p.deadline); // the last valid second
        launcher.launch(p, sig, 0, 0);
        launcher.launchFtf(f, ftfSig, 0, 0);
        vm.stopPrank();
    }

    /// Every signed field is really signed: changing any one voids the pass.
    function test_everyPersonalFieldIsSigned() public {
        NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, "alice");
        bytes memory sig = _sign(p, signerPk);
        NeuriioLauncher.LaunchPass[] memory changed = new NeuriioLauncher.LaunchPass[](6);
        for (uint256 i; i < 6; ++i) {
            changed[i] = _pass(alice, 1, "alice");
        }
        changed[0].xUserId = 2;
        changed[1].handle = "alicf";
        changed[2].category = 2;
        changed[3].profileHash = keccak256("other");
        changed[4].deadline += 1;
        changed[5].launchData = hex"01";
        vm.startPrank(alice);
        for (uint256 i; i < 6; ++i) {
            vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
            launcher.launch(changed[i], sig, 0, 0);
        }
        vm.stopPrank();
    }

    function test_everyFtfFieldIsSigned() public {
        NeuriioLauncher.FtfPass memory base = _ftfPass("Degen Den", "DEN");
        bytes memory sig = _signFtf(base, signerPk);
        NeuriioLauncher.FtfPass[] memory changed = new NeuriioLauncher.FtfPass[](7);
        for (uint256 i; i < 7; ++i) {
            changed[i] = _ftfPass("Degen Den", "DEN");
        }
        changed[0].name = "Degen Dem";
        changed[1].ticker = "DEM";
        changed[2].memberXIds[2] = 99;
        changed[3].members[3] = address(0xBAD);
        changed[4].profileHash = keccak256("other");
        changed[5].deadline += 1;
        changed[6].launchData = hex"01";
        vm.startPrank(alice);
        for (uint256 i; i < 7; ++i) {
            vm.expectRevert(NeuriioLauncher.InvalidPass.selector);
            launcher.launchFtf(changed[i], sig, 0, 0);
        }
        vm.stopPrank();
    }

    /// Two valid FTF passes for one ticker, if the backend ever signed both: first come, first served, and the loser can
    /// still launch with a new pass.
    function test_ftfTickerRaceFirstComeFirstServed() public {
        _launchFtf("First Den", "DEN");
        NeuriioLauncher.FtfPass memory second = _ftfPass("Second Den", "DEN");
        bytes memory sig = _signFtf(second, signerPk);
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.TickerTaken.selector);
        launcher.launchFtf(second, sig, 0, 0);
        _launchFtf("Second Den", "DEN2");
    }

    /// FINDING M-01 (carried over from the old audit, acknowledged). A leaked launch signer can sign a pass for anyone's X
    /// account, and the identity it takes can't be undone by anyone. The stop is the guardian's pause, at once.
    function test_M01_leakedSignerSquatsAnIdentityForGood() public {
        address attacker = makeAddr("attacker");
        address squatted = _launch(attacker, 12345, "elonmusk");
        assertEq(launcher.tokenOfXUser(12345), squatted);
        _expectAlreadyLaunched(alice, 12345, "elonmusk"); // the real owner can never launch
        vm.prank(guardian);
        launcher.pause();
        NeuriioLauncher.LaunchPass memory p = _pass(attacker, 777, "next_victim");
        bytes memory sig = _sign(p, signerPk);
        vm.prank(attacker);
        vm.expectRevert();
        launcher.launch(p, sig, 0, 0);
    }

    function _expectAlreadyLaunched(address who, uint64 xId, string memory handle) internal {
        NeuriioLauncher.LaunchPass memory p = _pass(who, xId, handle);
        bytes memory sig = _sign(p, signerPk);
        vm.prank(who);
        vm.expectRevert(NeuriioLauncher.AlreadyLaunched.selector);
        launcher.launch(p, sig, 0, 0);
    }
}
