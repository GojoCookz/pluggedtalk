// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PluggedCampaign} from "../src/PluggedCampaign.sol";
import {PluggedCashback} from "../src/PluggedCashback.sol";
import {ProgramPayments} from "../src/ProgramPayments.sol";
import {QuoteToken, RejectNative} from "./PluggedFeeSplitter.t.sol";

contract ProgramsTest is Test {
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    uint256 key = 0xCA55;
    QuoteToken quote;
    PluggedCampaign campaign;
    PluggedCashback cashback;

    function setUp() public {
        vm.warp(1000);
        quote = new QuoteToken();
        campaign = new PluggedCampaign(address(quote), bob, 100e6, 2000);
        cashback = new PluggedCashback(address(quote), vm.addr(key), 1000, 100e6);
        quote.mint(alice, 1000e6);
        vm.startPrank(alice);
        quote.approve(address(campaign), type(uint256).max);
        quote.approve(address(cashback), type(uint256).max);
        vm.stopPrank();
    }

    function sign(PluggedCashback target, uint256 signer, address trader, uint256 fees, uint256 expiry)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(signer, target.voucherDigest(trader, fees, expiry, keccak256("trades")));
        return abi.encodePacked(r, s, v);
    }

    function claim(
        PluggedCashback target,
        address trader,
        uint256 fees,
        uint256 expiry,
        bytes memory signature
    ) internal {
        target.claim(trader, fees, expiry, keccak256("trades"), signature);
    }

    function test_SuccessPaysFixedBeneficiaryOnlyAfterDeadline() public {
        vm.prank(alice);
        campaign.contribute(120e6);
        vm.expectRevert(PluggedCampaign.WrongPhase.selector);
        campaign.payout();
        vm.warp(2000);
        campaign.payout();
        assertEq(quote.balanceOf(bob), 120e6);
        vm.expectRevert(PluggedCampaign.WrongPhase.selector);
        campaign.payout();
        vm.expectRevert(PluggedCampaign.WrongPhase.selector);
        campaign.refund(alice);
    }

    function test_FailedCampaignRefundsContributorNotCaller() public {
        vm.prank(alice);
        campaign.contribute(99e6);
        vm.expectRevert(PluggedCampaign.WrongPhase.selector);
        campaign.refund(alice);
        vm.warp(2000);
        vm.expectRevert(PluggedCampaign.WrongPhase.selector);
        campaign.payout();
        vm.prank(bob);
        campaign.refund(alice);
        assertEq(quote.balanceOf(alice), 1000e6);
        assertEq(quote.balanceOf(bob), 0);
        assertEq(campaign.totalRefunded(), 99e6);
        vm.expectRevert(PluggedCampaign.NothingToRefund.selector);
        campaign.refund(alice);
    }

    function test_DirectTransfersCannotForceSuccessfulGoal() public {
        vm.prank(alice);
        campaign.contribute(1e6);
        quote.mint(address(campaign), 100e6);
        vm.warp(2000);
        campaign.refund(alice);
        assertEq(quote.balanceOf(alice), 1000e6);
        assertEq(campaign.totalContributed(), 1e6);
    }

    function test_RejectsLateZeroTaxedAndWrongNativePayments() public {
        vm.expectRevert(ProgramPayments.InvalidPayment.selector);
        campaign.contribute(0);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(ProgramPayments.InvalidPayment.selector);
        campaign.contribute{value: 1}(1e6);
        quote.setTax(true);
        vm.prank(alice);
        vm.expectRevert(ProgramPayments.UnsupportedToken.selector);
        campaign.contribute(10e6);
        assertEq(campaign.totalContributed(), 0);
        vm.warp(2000);
        vm.prank(alice);
        vm.expectRevert(PluggedCampaign.WrongPhase.selector);
        campaign.contribute(1e6);
    }

    function test_NativeFailureRefundAndSuccess() public {
        PluggedCampaign nativeCampaign = new PluggedCampaign(address(0), bob, 2 ether, 2000);
        vm.deal(alice, 3 ether);
        vm.prank(alice);
        nativeCampaign.contribute{value: 1 ether}(1 ether);
        vm.warp(2000);
        nativeCampaign.refund(alice);
        assertEq(alice.balance, 3 ether);
        nativeCampaign = new PluggedCampaign(address(0), bob, 1 ether, 3000);
        vm.prank(alice);
        nativeCampaign.contribute{value: 1 ether}(1 ether);
        vm.warp(3000);
        nativeCampaign.payout();
        assertEq(bob.balance, 1 ether);
    }

    function test_RejectingBeneficiaryDoesNotMarkPaid() public {
        RejectNative reject = new RejectNative();
        PluggedCampaign nativeCampaign = new PluggedCampaign(address(0), address(reject), 1 ether, 2000);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        nativeCampaign.contribute{value: 1 ether}(1 ether);
        vm.warp(2000);
        vm.expectRevert(ProgramPayments.PaymentFailed.selector);
        nativeCampaign.payout();
        assertFalse(nativeCampaign.paid());
    }

    function test_CashbackCumulativeClaimReplayAndIncrement() public {
        vm.prank(alice);
        cashback.fund(100e6);
        bytes memory sig = sign(cashback, key, bob, 100e6, 3000);
        vm.prank(alice);
        claim(cashback, bob, 100e6, 3000, sig);
        assertEq(quote.balanceOf(bob), 10e6);
        vm.expectRevert(PluggedCashback.NothingToClaim.selector);
        claim(cashback, bob, 100e6, 3000, sig);
        sig = sign(cashback, key, bob, 150e6, 3000);
        claim(cashback, bob, 150e6, 3000, sig);
        assertEq(quote.balanceOf(bob), 15e6);
        assertEq(cashback.totalClaimed(), 15e6);
        assertEq(quote.balanceOf(address(cashback)), 85e6);
    }

    function test_CashbackRejectsForgedExpiredWrongTraderAndWrongDomain() public {
        vm.prank(alice);
        cashback.fund(100e6);
        bytes memory sig = sign(cashback, key + 1, bob, 100e6, 3000);
        vm.expectRevert(PluggedCashback.InvalidVoucher.selector);
        claim(cashback, bob, 100e6, 3000, sig);
        sig = sign(cashback, key, bob, 100e6, 999);
        vm.expectRevert(PluggedCashback.InvalidVoucher.selector);
        claim(cashback, bob, 100e6, 999, sig);
        sig = sign(cashback, key, bob, 100e6, 3000);
        vm.expectRevert(PluggedCashback.InvalidVoucher.selector);
        claim(cashback, alice, 100e6, 3000, sig);
        PluggedCashback other = new PluggedCashback(address(quote), vm.addr(key), 1000, 100e6);
        vm.expectRevert(PluggedCashback.InvalidVoucher.selector);
        claim(other, bob, 100e6, 3000, sig);
    }

    function test_CashbackBudgetAndSeparateEscrowAccounting() public {
        vm.prank(alice);
        campaign.contribute(99e6);
        bytes memory sig = sign(cashback, key, bob, 100e6, 3000);
        vm.expectRevert(PluggedCashback.BudgetExceeded.selector);
        claim(cashback, bob, 100e6, 3000, sig);
        vm.prank(alice);
        cashback.fund(100e6);
        vm.expectRevert(PluggedCashback.BudgetExceeded.selector);
        cashback.fund(1);
        sig = sign(cashback, key, bob, 1001e6, 3000);
        vm.expectRevert(PluggedCashback.BudgetExceeded.selector);
        claim(cashback, bob, 1001e6, 3000, sig);
        assertEq(cashback.claimed(bob), 0);
        assertEq(quote.balanceOf(address(campaign)), 99e6);
        vm.warp(2000);
        campaign.refund(alice);
        assertEq(quote.balanceOf(address(cashback)), 100e6);
    }

    function testFuzz_FailedEscrowConservesDeposits(uint96 raw) public {
        uint256 amount = bound(raw, 1, 99e6);
        vm.prank(alice);
        campaign.contribute(amount);
        vm.warp(2000);
        campaign.refund(alice);
        assertEq(quote.balanceOf(alice), 1000e6);
        assertEq(quote.balanceOf(address(campaign)), 0);
        assertEq(campaign.totalContributed(), campaign.totalRefunded());
    }

    function testFuzz_CashbackConservation(uint96 raw) public {
        uint256 fees = bound(raw, 10, 1000e6);
        vm.prank(alice);
        cashback.fund(100e6);
        claim(cashback, bob, fees, 3000, sign(cashback, key, bob, fees, 3000));
        assertEq(quote.balanceOf(bob), fees / 10);
        assertEq(quote.balanceOf(address(cashback)) + cashback.totalClaimed(), cashback.totalFunded());
    }
}

contract CampaignHandler is Test {
    PluggedCampaign public campaign;
    QuoteToken public quote;
    uint256 public deposited;

    constructor(PluggedCampaign c, QuoteToken q) {
        campaign = c;
        quote = q;
        quote.approve(address(c), type(uint256).max);
    }

    function deposit(uint64 amount) external {
        if (block.timestamp >= campaign.DEADLINE() || amount == 0) return;
        quote.mint(address(this), amount);
        campaign.contribute(amount);
        deposited += amount;
    }

    function finish() external {
        vm.warp(campaign.DEADLINE());
        if (campaign.totalContributed() >= campaign.GOAL()) {
            if (!campaign.paid()) campaign.payout();
        } else if (campaign.contributions(address(this)) > 0) {
            campaign.refund(address(this));
        }
    }
}

contract CampaignInvariantTest is StdInvariant, Test {
    QuoteToken quote;
    PluggedCampaign campaign;
    CampaignHandler handler;

    function setUp() public {
        quote = new QuoteToken();
        campaign = new PluggedCampaign(address(quote), address(0xB0B), 1e18, block.timestamp + 1 days);
        handler = new CampaignHandler(campaign, quote);
        targetContract(address(handler));
    }

    function invariant_ConservationAndExclusivePayout() public view {
        assertEq(
            quote.balanceOf(address(campaign)) + quote.balanceOf(address(handler))
                + quote.balanceOf(address(0xB0B)),
            handler.deposited()
        );
        assertFalse(campaign.paid() && campaign.totalRefunded() > 0);
    }

    function test_HandlerFinishesFailedCampaignAndRepeatedSuccess() public {
        handler.deposit(100);
        handler.finish();
        assertEq(campaign.totalRefunded(), 100);
        handler.finish();
        assertEq(campaign.totalRefunded(), 100);
        vm.warp(1);
        setUp();
        handler.deposit(1e18);
        handler.finish();
        handler.finish();
        assertTrue(campaign.paid());
        assertEq(campaign.totalRefunded(), 0);
    }
}
