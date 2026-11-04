// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {NeuriioLauncher} from "../../src/launch/NeuriioLauncher.sol";
import {AscendAuditBase} from "./AscendAuditBase.sol";

/// Cantina risks 3 and 10 (identity uniqueness, FTF structure): the launcher's rules checked against independent versions of
/// them here, on generated input, and every key tested across every dimension.
contract AuditLauncherIdentityTest is AscendAuditBase {
    uint64 nextId = 1_000;
    uint256 nextWallet = 0xAAAA;

    function _wallet() internal returns (address) {
        return address(uint160(nextWallet++));
    }

    /// Turns random bytes into a handle-like string, mostly from the legal characters.
    function _generate(bytes memory seed, uint256 maxLen, bytes memory alphabet) internal pure returns (string memory) {
        uint256 n = seed.length > maxLen ? maxLen : seed.length;
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            uint8 c = uint8(seed[i]);
            out[i] = c < 225 ? alphabet[c % alphabet.length] : bytes1(c ^ 0x55); // about 1 in 9: anything at all
        }
        return string(out);
    }

    function _lower(bytes1 c) internal pure returns (bytes1) {
        return c >= "A" && c <= "Z" ? bytes1(uint8(c) + 32) : c;
    }

    function _upper(bytes1 c) internal pure returns (bytes1) {
        return c >= "a" && c <= "z" ? bytes1(uint8(c) - 32) : c;
    }

    function _isReserved(string memory symbol) internal view returns (bool) {
        return launcher.reservedTicker(keccak256(bytes(symbol)));
    }

    function testFuzz_handleRules(bytes memory seed) public {
        string memory handle = _generate(seed, 18, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_");
        bytes memory h = bytes(handle);
        bool valid = h.length >= 1 && h.length <= 15;
        bytes memory upper = new bytes(h.length);
        bytes memory lower = new bytes(h.length);
        for (uint256 i; i < h.length; ++i) {
            bytes1 c = h[i];
            bool alnum = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == "_";
            valid = valid && alnum;
            upper[i] = _upper(c);
            lower[i] = _lower(c);
        }
        address who = _wallet();
        NeuriioLauncher.LaunchPass memory p = _pass(who, 5, handle);
        bytes memory sig = _sign(p, signerPk);
        bool reserved = _isReserved(string(upper));
        vm.prank(who);
        if (!valid) {
            vm.expectRevert(NeuriioLauncher.InvalidMetadata.selector);
            launcher.launch(p, sig, 0, 0);
        } else if (reserved) {
            vm.expectRevert(NeuriioLauncher.TickerIsReserved.selector);
            launcher.launch(p, sig, 0, 0);
        } else {
            address token = launcher.launch(p, sig, 0, 0);
            assertEq(adapter.lastSymbol(), string(upper));
            assertEq(adapter.lastName(), string.concat("@", handle));
            assertEq(launcher.tokenOfHandle(keccak256(lower)), token);
        }
    }

    function testFuzz_ftfNameRules(bytes memory seed) public {
        string memory name = _generate(seed, 36, "abcXYZ019 -_.&' ");
        bytes memory b = bytes(name);
        bool valid = b.length >= 1 && b.length <= 32 && b[0] != " " && b[b.length - 1] != " ";
        for (uint256 i; valid && i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c == " " || c == "-"
                || c == "_" || c == "." || c == "&" || c == "'";
            valid = ok && !(c == " " && b[i - 1] == " ");
        }
        NeuriioLauncher.FtfPass memory p = _ftfPass(name, "DEN");
        bytes memory sig = _signFtf(p, signerPk);
        vm.prank(alice);
        if (!valid) vm.expectRevert(NeuriioLauncher.InvalidMetadata.selector);
        launcher.launchFtf(p, sig, 0, 0);
    }

    function testFuzz_ftfTickerRules(bytes memory seed) public {
        string memory ticker = _generate(seed, 12, "ABCXYZ019a");
        bytes memory b = bytes(ticker);
        bool valid = b.length >= 2 && b.length <= 10;
        for (uint256 i; i < b.length; ++i) {
            valid = valid && ((b[i] >= "A" && b[i] <= "Z") || (b[i] >= "0" && b[i] <= "9"));
        }
        NeuriioLauncher.FtfPass memory p = _ftfPass("Degen Den", ticker);
        bytes memory sig = _signFtf(p, signerPk);
        bool reserved = _isReserved(ticker);
        vm.prank(alice);
        if (!valid) vm.expectRevert(NeuriioLauncher.InvalidMetadata.selector);
        else if (reserved) vm.expectRevert(NeuriioLauncher.TickerIsReserved.selector);
        address token = launcher.launchFtf(p, sig, 0, 0);
        if (valid && !reserved) assertEq(launcher.tokenOfFtfTicker(keccak256(b)), token);
    }

    /// Any casing of a taken handle is taken, and its ticker can't exist twice.
    function testFuzz_handleUniqueIgnoringCase(uint256 caseBits) public {
        bytes memory base = "some_Handle42";
        _launch(alice, 1, string(base));
        bytes memory variant = new bytes(base.length);
        for (uint256 i; i < base.length; ++i) {
            variant[i] = (caseBits >> i) & 1 == 1 ? _upper(base[i]) : _lower(base[i]);
        }
        NeuriioLauncher.LaunchPass memory p = _pass(bob, 2, string(variant));
        bytes memory sig = _sign(p, signerPk);
        vm.prank(bob);
        vm.expectRevert(NeuriioLauncher.AlreadyLaunched.selector);
        launcher.launch(p, sig, 0, 0);
    }

    /// Each reserved ticker is blocked in every casing, and reserved is reported before taken.
    function test_reservedInAnyCasing() public {
        string[4] memory forms = ["USDC", "usdc", "UsDc", "uSdC"];
        for (uint256 i; i < forms.length; ++i) {
            NeuriioLauncher.LaunchPass memory p = _pass(alice, 1, forms[i]);
            bytes memory sig = _sign(p, signerPk);
            vm.prank(alice);
            vm.expectRevert(NeuriioLauncher.TickerIsReserved.selector);
            launcher.launch(p, sig, 0, 0);
        }
        string[19] memory all = [
            "HYPE",
            "WHYPE",
            "KHYPE",
            "STHYPE",
            "USDC",
            "USDT",
            "USDH",
            "USDE",
            "USD",
            "DAI",
            "ETH",
            "WETH",
            "BTC",
            "WBTC",
            "UBTC",
            "SOL",
            "KNTQ",
            "PURR",
            "NEURIIO"
        ];
        for (uint256 i; i < all.length; ++i) {
            assertTrue(_isReserved(all[i]), all[i]);
        }
    }

    /// One dimension taken blocks the launch, and a failed launch leaves every other key free.
    function test_noCrossDimensionCollision() public {
        address token = _launch(alice, 1, "alice");

        NeuriioLauncher.LaunchPass[3] memory clash =
            [_pass(bob, 1, "bob"), _pass(alice, 2, "bob"), _pass(bob, 2, "ALICE")];
        for (uint256 i; i < 3; ++i) {
            bytes memory sig = _sign(clash[i], signerPk);
            vm.prank(clash[i].creator);
            vm.expectRevert(NeuriioLauncher.AlreadyLaunched.selector);
            launcher.launch(clash[i], sig, 0, 0);
        }
        assertEq(launcher.tokenOfXUser(2), address(0));
        assertEq(launcher.tokenOfCreator(bob), address(0));
        assertEq(launcher.tokenOfHandle(keccak256("bob")), address(0));

        address second = _launch(bob, 2, "bob");
        assertTrue(second != token);
        assertEq(launcher.tokenOfXUser(1), token);
        assertEq(launcher.tokenOfXUser(2), second);
    }

    function test_personalAndFtfNamespacesAreSeparate() public {
        address ftf = _launchFtf("Degen Den", "ALICE");
        address personal = _launch(alice, 1, "alice");
        assertTrue(launcher.isFtf(ftf) && !launcher.isFtf(personal));
        assertEq(launcher.tokenOfFtfTicker(keccak256("ALICE")), ftf);
        assertEq(launcher.tokenOfHandle(keccak256("alice")), personal);
        assertEq(launcher.tokenOfCreator(alice), personal); // an FTF doesn't count as the founder's own launch
    }

    /// Exactly 4 distinct members, founder first, whatever pair of positions repeats.
    function test_ftfMembersEveryRepeatRefused() public {
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 4; ++j) {
                if (i == j) continue;
                NeuriioLauncher.FtfPass memory ids = _ftfPass("Degen Den", "DEN");
                ids.memberXIds[i] = ids.memberXIds[j];
                _expectFtf(ids, NeuriioLauncher.InvalidMembers.selector);
                if (j == 0 || i == 0) continue; // a changed members[0] fails the founder check instead
                NeuriioLauncher.FtfPass memory wallets = _ftfPass("Degen Den", "DEN");
                wallets.members[i] = wallets.members[j];
                _expectFtf(wallets, NeuriioLauncher.InvalidMembers.selector);
            }
        }
    }

    function test_ftfFounderMustBeSenderAndFirst() public {
        NeuriioLauncher.FtfPass memory p = _ftfPass("Degen Den", "DEN");
        p.members[0] = bob;
        p.members[1] = alice; // alice is a member, but not first
        bytes memory sig = _signFtf(p, signerPk);
        vm.prank(alice);
        vm.expectRevert(NeuriioLauncher.NotPassHolder.selector);
        launcher.launchFtf(p, sig, 0, 0);
        NeuriioLauncher.FtfPass memory q = _ftfPass("Degen Den", "DEN");
        sig = _signFtf(q, signerPk);
        vm.prank(bob); // a member, but not the founder
        vm.expectRevert(NeuriioLauncher.NotPassHolder.selector);
        launcher.launchFtf(q, sig, 0, 0);
    }

    /// Even a signed pass can't be sent by someone its founder field doesn't name.
    function test_ftfFounderFieldMustMatchTheSender() public {
        NeuriioLauncher.FtfPass memory p = _ftfPass("Degen Den", "DEN");
        p.founder = bob;
        bytes memory sig = _signFtf(p, signerPk);
        vm.prank(alice); // members[0], but not the founder
        vm.expectRevert(NeuriioLauncher.NotPassHolder.selector);
        launcher.launchFtf(p, sig, 0, 0);
    }

    function test_ftfRecordIsFixedAndComplete() public {
        address token = _launchFtf("Degen Den", "DEN");
        NeuriioLauncher.Ftf memory f = launcher.ftf(token);
        address[] memory creators = launcher.creatorsOf(token);
        address[4] memory expected = [alice, bob, carol, dan];
        assertEq(creators.length, 4);
        assertEq(adapter.creators().length, 4);
        for (uint256 i; i < 4; ++i) {
            assertEq(f.members[i], expected[i]);
            assertEq(f.memberXIds[i], i + 1);
            assertEq(creators[i], expected[i]);
            assertEq(adapter.creators()[i], expected[i]);
        }
    }

    function _expectFtf(NeuriioLauncher.FtfPass memory p, bytes4 err) internal {
        bytes memory sig = _signFtf(p, signerPk);
        vm.prank(p.founder);
        vm.expectRevert(err);
        launcher.launchFtf(p, sig, 0, 0);
    }
}
