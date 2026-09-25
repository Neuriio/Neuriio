// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ERC7579Utils} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {Execution} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {Account as OZAccount} from "@openzeppelin/contracts/account/Account.sol";
import {KeeperHyperCoreOracle} from "../src/oracle/KeeperHyperCoreOracle.sol";
import {PropAMM} from "../src/amm/PropAMM.sol";
import {FastBridge} from "../src/bridge/FastBridge.sol";
import {NeuriioAccount} from "../src/account/NeuriioAccount.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract NeuriioAccountTest is Test {
    uint64 constant T0 = 1_790_000_000;
    bytes32 constant BATCH_MODE = bytes32(uint256(0x01) << 248); // ERC-7821 single batch, default exec

    MockERC20 usdc;
    MockERC20 hype;
    PropAMM pool;
    FastBridge bridge;
    NeuriioAccount impl;

    uint256 alicePk = 0xA11CE;
    address alice; // the user's wallet (EOA delegated to `impl`)
    uint256 devicePk = 0xDE71CE; // session key on the user's phone
    address device;
    address sponsor = makeAddr("sponsor"); // our gas payer
    address relayer = makeAddr("relayer");

    function setUp() public {
        vm.warp(T0);
        alice = vm.addr(alicePk);
        device = vm.addr(devicePk);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        hype = new MockERC20("Hype", "HYPE", 18);

        KeeperHyperCoreOracle oracle = new KeeperHyperCoreOracle(address(this), 500);
        oracle.setUpdater(address(this), true);
        KeeperHyperCoreOracle.Update[] memory u = new KeeperHyperCoreOracle.Update[](1);
        u[0] = KeeperHyperCoreOracle.Update(107, 40e18, 40.01e18, 1_000e18, 1_000e18, 0, T0 * 1000);
        oracle.push(u);
        pool = new PropAMM(
            address(this),
            IERC20Metadata(address(hype)),
            IERC20Metadata(address(usdc)),
            oracle,
            107,
            PropAMM.RiskParams(5, 1_000, 0, 5_000, 50, 50),
            PropAMM.QuoteParams(5, 5_000, 0, 0, 0)
        );
        hype.mint(address(this), 1_000e18);
        usdc.mint(address(this), 40_000e6);
        hype.approve(address(pool), type(uint256).max);
        usdc.approve(address(pool), type(uint256).max);
        pool.deposit(1_000e18, 40_000e6);

        bridge = new FastBridge(
            address(this),
            IERC20(address(usdc)),
            FastBridge.Config({
                feeBps: 0,
                minFee: 0,
                maxDeposit: 25_000e6,
                refundDelay: 1 hours,
                maxPayout: 25_000e6,
                dailyPayoutCap: 100_000e6
            })
        );
        bridge.setRelayer(relayer, true);
        bridge.setPool(address(hype), pool);
        vm.prank(relayer);
        bridge.increaseCredit(1_000_000e6);

        impl = new NeuriioAccount(bridge);
        vm.signAndAttachDelegation(address(impl), alicePk);
        vm.prank(alice); // a real 7702 tx; delegation persists afterwards
        NeuriioAccount(payable(alice)).addSession(device, uint48(T0 + 30 days), 1_000e6, 2_500e6);

        usdc.mint(alice, 100_000e6);
        hype.mint(alice, 1_000e18);
    }

    function acct() internal view returns (NeuriioAccount) {
        return NeuriioAccount(payable(alice));
    }

    // ------------------------------------------------------------------ signing helpers

    function _domain(address account) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Neuriio Account"),
                keccak256("1"),
                block.chainid,
                account
            )
        );
    }

    function _sig(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", _domain(alice), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _order(address token, uint256 amountIn, uint256 nonce) internal view returns (NeuriioAccount.Buy memory) {
        return NeuriioAccount.Buy(token, amountIn, 0, block.timestamp + 60, nonce);
    }

    function _signBuy(uint256 pk, NeuriioAccount.Buy memory b) internal view returns (bytes memory) {
        return
            _sig(pk, keccak256(abi.encode(impl.BUY_TYPEHASH(), b.token, b.amountIn, b.minUsdcOut, b.deadline, b.nonce)));
    }

    function _buy(uint256 pk, NeuriioAccount.Buy memory b) internal returns (uint256) {
        bytes memory sig = _signBuy(pk, b);
        vm.prank(sponsor);
        return acct().buy(b, sig);
    }

    function _buyReverts(uint256 pk, NeuriioAccount.Buy memory b, bytes memory err) internal {
        bytes memory sig = _signBuy(pk, b); // sign first: expectRevert must see the buy, not a view call
        vm.expectRevert(err);
        vm.prank(sponsor);
        acct().buy(b, sig);
    }

    function _dep(uint256 id) internal view returns (FastBridge.Deposit memory d) {
        (d.user, d.createdAt, d.status, d.hlRecipient, d.amount, d.fee) = bridge.deposits(id);
    }

    // ------------------------------------------------------------------ delegation

    function test_walletIsDelegated() public view {
        assertEq(alice.code, abi.encodePacked(hex"ef0100", address(impl)));
        NeuriioAccount.Session memory s = acct().session(device);
        assertEq(s.maxPerBuy, 1_000e6);
        assertEq(s.validUntil, T0 + 30 days);
    }

    function test_walletStillReceivesHype() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = alice.call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(alice.balance, 1 ether);
    }

    // ------------------------------------------------------------------ one-click buy

    function test_buyWithUsdc_sponsoredAndCreditsOwnHyperCoreAccount() public {
        vm.expectEmit(alice);
        emit NeuriioAccount.Bought(device, 1, address(usdc), 500e6, 500e6);
        uint256 id = _buy(devicePk, _order(address(usdc), 500e6, 1));

        FastBridge.Deposit memory d = _dep(id);
        assertEq(d.user, alice, "refunds go back to the wallet");
        assertEq(d.hlRecipient, alice, "credited to the user's own HyperCore account");
        assertEq(d.amount, 500e6);
        assertEq(usdc.balanceOf(alice), 100_000e6 - 500e6);
        assertEq(usdc.allowance(alice, address(bridge)), 0, "no lingering approval");
        assertEq(sponsor.balance, 0);
    }

    function test_buyWithAnyPooledToken_noPriorApproval() public {
        (uint256 expected,) = pool.previewSellBase(10e18);
        uint256 id = _buy(devicePk, NeuriioAccount.Buy(address(hype), 10e18, expected, block.timestamp + 60, 7));
        assertEq(uint256(_dep(id).amount) + _dep(id).fee, expected);
        assertEq(hype.balanceOf(alice), 990e18);
        assertEq(acct().session(device).spentToday, expected);
    }

    function test_revert_replay() public {
        NeuriioAccount.Buy memory b = _order(address(usdc), 100e6, 42);
        bytes memory sig = _signBuy(devicePk, b);
        acct().buy(b, sig);
        vm.expectRevert(abi.encodeWithSelector(NeuriioAccount.NonceUsed.selector, 42));
        acct().buy(b, sig);
    }

    function test_revert_tamperedOrder() public {
        NeuriioAccount.Buy memory b = _order(address(usdc), 100e6, 1);
        bytes memory sig = _signBuy(devicePk, b);
        b.amountIn = 900e6; // recovers a different, unknown key
        vm.expectRevert();
        acct().buy(b, sig);
        assertEq(usdc.balanceOf(alice), 100_000e6);
    }

    function test_revert_unknownKey() public {
        uint256 thiefPk = 0xBAD;
        _buyReverts(
            thiefPk,
            _order(address(usdc), 100e6, 1),
            abi.encodeWithSelector(NeuriioAccount.InvalidSession.selector, vm.addr(thiefPk))
        );
    }

    function test_revert_orderExpired() public {
        NeuriioAccount.Buy memory b = _order(address(usdc), 100e6, 1);
        bytes memory sig = _signBuy(devicePk, b);
        vm.warp(b.deadline + 1);
        vm.expectRevert(NeuriioAccount.Expired.selector);
        acct().buy(b, sig);
    }

    function test_revert_sessionExpired() public {
        vm.warp(T0 + 30 days + 1);
        _buyReverts(
            devicePk,
            _order(address(usdc), 100e6, 1),
            abi.encodeWithSelector(NeuriioAccount.InvalidSession.selector, device)
        );
    }

    function test_revert_perBuyCap() public {
        _buyReverts(
            devicePk,
            _order(address(usdc), 1_000e6 + 1, 1),
            abi.encodeWithSelector(NeuriioAccount.OverPerBuyCap.selector, 1_000e6 + 1, 1_000e6)
        );
    }

    function test_dailyCapResetsNextUtcDay() public {
        _buy(devicePk, _order(address(usdc), 1_000e6, 1));
        _buy(devicePk, _order(address(usdc), 1_000e6, 2));
        _buyReverts(
            devicePk,
            _order(address(usdc), 1_000e6, 3),
            abi.encodeWithSelector(NeuriioAccount.OverDailyCap.selector, 3_000e6, 2_500e6)
        );
        _buy(devicePk, _order(address(usdc), 500e6, 4)); // exactly at the cap

        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        _buy(devicePk, _order(address(usdc), 1_000e6, 5));
        assertEq(acct().session(device).spentToday, 1_000e6);
    }

    function testFuzz_capsAlwaysHold(uint256[5] memory amounts) public {
        uint256 spent;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 a = bound(amounts[i], 1, 1_500e6);
            NeuriioAccount.Buy memory b = _order(address(usdc), a, i);
            bytes memory sig = _signBuy(devicePk, b);
            if (a > 1_000e6 || spent + a > 2_500e6) {
                vm.expectRevert();
                acct().buy(b, sig);
            } else {
                acct().buy(b, sig);
                spent += a;
            }
        }
        assertEq(usdc.balanceOf(alice), 100_000e6 - spent);
        assertLe(spent, 2_500e6);
    }

    // ------------------------------------------------------------------ session management

    function test_revert_onlyWalletManagesSessions() public {
        vm.expectRevert(NeuriioAccount.OnlySelf.selector);
        vm.prank(device);
        acct().addSession(device, uint48(T0 + 365 days), type(uint64).max, type(uint64).max);
        vm.expectRevert(NeuriioAccount.OnlySelf.selector);
        vm.prank(sponsor);
        acct().revokeSession(device);
    }

    function test_revokeSession() public {
        vm.prank(alice);
        acct().revokeSession(device);
        _buyReverts(
            devicePk,
            _order(address(usdc), 100e6, 1),
            abi.encodeWithSelector(NeuriioAccount.InvalidSession.selector, device)
        );
    }

    function test_revokeAllSessions() public {
        vm.prank(alice);
        acct().revokeAllSessions();
        _buyReverts(
            devicePk,
            _order(address(usdc), 100e6, 1),
            abi.encodeWithSelector(NeuriioAccount.InvalidSession.selector, device)
        );
    }

    function _addSessionSig(uint256 pk, address key, uint32 ep, uint256 nonce) internal view returns (bytes memory) {
        return _sig(
            pk,
            keccak256(
                abi.encode(
                    impl.ADD_SESSION_TYPEHASH(), key, uint48(T0 + 1 days), uint64(50e6), uint64(100e6), ep, nonce
                )
            )
        );
    }

    function test_addSessionWithSig_gasFreeSetup() public {
        address phone2 = makeAddr("phone2");
        bytes memory sig = _addSessionSig(alicePk, phone2, 0, 9);
        vm.prank(sponsor);
        acct().addSessionWithSig(phone2, uint48(T0 + 1 days), 50e6, 100e6, 0, 9, sig);
        assertEq(acct().session(phone2).maxPerDay, 100e6);

        vm.expectRevert(abi.encodeWithSelector(NeuriioAccount.NonceUsed.selector, 9));
        acct().addSessionWithSig(phone2, uint48(T0 + 1 days), 50e6, 100e6, 0, 9, sig);
    }

    function test_revert_addSessionWithSig_notOwner() public {
        bytes memory sig = _addSessionSig(devicePk, device, 0, 1); // a session key can't grant itself more
        vm.expectRevert(NeuriioAccount.BadSignature.selector);
        acct().addSessionWithSig(device, uint48(T0 + 1 days), 50e6, 100e6, 0, 1, sig);
    }

    function test_revert_addSessionWithSig_afterRevokeAll() public {
        address phone2 = makeAddr("phone2");
        bytes memory sig = _addSessionSig(alicePk, phone2, 0, 1); // signed, never submitted
        vm.prank(alice);
        acct().revokeAllSessions();
        vm.expectRevert(abi.encodeWithSelector(NeuriioAccount.StaleEpoch.selector, 0, 1));
        acct().addSessionWithSig(phone2, uint48(T0 + 1 days), 50e6, 100e6, 0, 1, sig);
    }

    function test_revert_invalidSessionParams() public {
        vm.startPrank(alice);
        vm.expectRevert(NeuriioAccount.InvalidParams.selector);
        acct().addSession(address(0), uint48(T0 + 1 days), 1, 1);
        vm.expectRevert(NeuriioAccount.InvalidParams.selector);
        acct().addSession(device, uint48(T0), 1, 1); // already expired
        vm.expectRevert(NeuriioAccount.InvalidParams.selector);
        acct().addSession(device, uint48(T0 + 1 days), 2, 1); // day cap below buy cap
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ owner powers

    function _batch(address target, bytes memory data) internal pure returns (bytes memory) {
        Execution[] memory calls = new Execution[](1);
        calls[0] = Execution(target, 0, data);
        return abi.encode(calls);
    }

    function test_ownerBatchesAndReclaimsRefund() public {
        uint256 id = _buy(devicePk, _order(address(usdc), 500e6, 1));
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        acct().execute(BATCH_MODE, _batch(address(bridge), abi.encodeCall(FastBridge.refund, (id))));
        assertEq(usdc.balanceOf(alice), 100_000e6);
    }

    function test_revert_onlyWalletExecutes() public {
        bytes memory data = _batch(address(usdc), abi.encodeCall(IERC20.transfer, (device, 1)));
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, device));
        vm.prank(device);
        acct().execute(BATCH_MODE, data);
    }

    function test_erc1271_ownerOnly() public view {
        bytes32 h = keccak256("login");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, h);
        assertEq(acct().isValidSignature(h, abi.encodePacked(r, s, v)), IERC1271.isValidSignature.selector);
        (v, r, s) = vm.sign(devicePk, h);
        assertEq(acct().isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
    }

    function test_storageIsNamespaced() public view {
        for (uint256 i; i < 8; ++i) {
            assertEq(vm.load(alice, bytes32(i)), bytes32(0), "low slots untouched");
        }
    }
}
