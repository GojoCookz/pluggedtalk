// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BasketLedger} from "carbon/src/multi/BasketLedger.sol";
import {MockERC20, MockBlacklistERC20} from "carbon/test/mocks/MockERC20.sol";
import {PluggedAdvancedLedger} from "../src/PluggedAdvancedLedger.sol";

contract AdvancedLedgerTest is Test {
    address internal constant HOLDER = address(0xBEEF);
    uint256 internal constant MAGNITUDE = 2 ** 128;
    MockERC20 internal quote;
    BasketLedger internal baseline;
    PluggedAdvancedLedger internal ledger;

    function setUp() public {
        quote = new MockBlacklistERC20("USDG mock", "USDG", 6);
        address[] memory currencies = new address[](1);
        currencies[0] = address(quote);
        uint256[] memory floors = new uint256[](1);
        floors[0] = 1;
        baseline = new BasketLedger(
            address(this), address(this), address(0x123), address(0x456), currencies, floors, 1, 1
        );
        ledger = new PluggedAdvancedLedger(
            address(this), address(this), address(0x123), address(0x456), currencies, floors, 1, 1
        );
        baseline.initFeed(address(quote), address(this));
        ledger.initFeed(address(quote), address(this));
        baseline.setBalance(HOLDER, 1 ether);
        ledger.setBalance(HOLDER, 1 ether);
    }

    /// @notice Negative control: the exact unchanged Carbon source double-books whole dust.
    ///         The Plugged adaptation must keep this one-unit stream funded through repeated flushes.
    function testFixedDustDoubleBookingAgainstExactCarbonNegativeControl() public {
        quote.mint(address(baseline), 1);
        quote.mint(address(ledger), 1);
        baseline.credit(address(quote), 1);
        ledger.credit(address(quote), 1);
        for (uint256 i; i < 5; ++i) {
            skip(1 days);
            baseline.flush(address(quote));
            ledger.flush(address(quote));
        }
        assertGt(baseline.totalDistributedOf(address(quote)), 1, "negative control must reproduce Carbon bug");
        assertGt(baseline.withdrawableOf(HOLDER, address(quote)), quote.balanceOf(address(baseline)));
        assertEq(ledger.totalDistributedOf(address(quote)), 1);
        assertLe(ledger.withdrawableOf(HOLDER, address(quote)), quote.balanceOf(address(ledger)));
        assertEq(ledger.bucketOf(address(quote)).pending, 0);
    }

    function testFuzzMagnifiedBudgetConservedAcrossTopUps(uint64 amount1, uint64 amount2, uint32 elapsed)
        public
    {
        uint256 first = bound(amount1, 1, 1e12);
        uint256 second = bound(amount2, 1, 1e12);
        uint256 time = bound(elapsed, 1, 2 days);
        quote.mint(address(ledger), first + second);
        ledger.credit(address(quote), first);
        skip(time);
        ledger.credit(address(quote), second);
        PluggedAdvancedLedger.Bucket memory b = ledger.bucketOf(address(quote));
        uint256 remaining = uint256(b.streamFinish - b.lastCheckpoint) * b.streamRate + b.remainderMag;
        assertEq(
            b.totalDistributed * MAGNITUDE + remaining + b.pending * MAGNITUDE, (first + second) * MAGNITUDE
        );
        skip(2 days);
        ledger.flush(address(quote));
        assertEq(ledger.totalDistributedOf(address(quote)), first + second);
        assertLe(ledger.withdrawableOf(HOLDER, address(quote)), first + second);
    }

    function testNoSharesCarryAndLateEntrantsDoNotGetHistoricalRewards() public {
        ledger.setBalance(HOLDER, 0);
        quote.mint(address(ledger), 10_000);
        ledger.credit(address(quote), 10_000);
        skip(2 days);
        assertEq(ledger.bucketOf(address(quote)).pending, 10_000);
        ledger.setBalance(HOLDER, 1 ether);
        ledger.flush(address(quote));
        skip(1 days);
        ledger.setBalance(HOLDER, 1 ether);
        uint256 owed = ledger.withdrawableOf(HOLDER, address(quote));
        assertGt(owed, 0);
        ledger.setBalance(address(0xB0B), 1 ether);
        assertEq(ledger.withdrawableOf(address(0xB0B), address(quote)), 0);
        vm.prank(HOLDER);
        ledger.withdrawOne(address(quote));
        assertEq(quote.balanceOf(HOLDER), owed);
    }

    function testBlockedBatchPayoutPreservesClaimAndDoesNotBlockOtherHolder() public {
        address other = address(0xB0B);
        ledger.setBalance(other, 1 ether);
        quote.mint(address(ledger), 10_000);
        ledger.credit(address(quote), 10_000);
        skip(1 days);
        uint256 holderOwed = ledger.withdrawableOf(HOLDER, address(quote));
        uint256 otherOwed = ledger.withdrawableOf(other, address(quote));
        assertGt(holderOwed, 0);
        assertGt(otherOwed, 0);
        MockBlacklistERC20(address(quote)).addBlackList(HOLDER);
        assertEq(ledger.processBatch(10), 1);
        assertEq(quote.balanceOf(other), otherOwed);
        assertEq(ledger.withdrawableOf(HOLDER, address(quote)), holderOwed);
        assertEq(ledger.withdrawnOf(HOLDER, address(quote)), 0);
        MockBlacklistERC20(address(quote)).removeBlackList(HOLDER);
        vm.prank(HOLDER);
        assertEq(ledger.withdraw(), 1);
        assertEq(quote.balanceOf(HOLDER), holderOwed);
        assertEq(ledger.totalWithdrawnOf(address(quote)), holderOwed + otherOwed);
        assertEq(ledger.processBatch(0), 0);
    }

    function testFeedAuthorityQueueAndExclusionCannotRetroactivelyStealClaims() public {
        address other = address(0xB0B);
        assertEq(ledger.marketCount(), 1);
        assertEq(ledger.marketAt(0), address(quote));
        assertEq(ledger.currencies()[0], address(quote));
        assertEq(ledger.queueLength(), 1);
        assertEq(ledger.queueAt(0), HOLDER);
        vm.prank(other);
        vm.expectRevert(PluggedAdvancedLedger.OnlyFeed.selector);
        ledger.credit(address(quote), 1);
        vm.prank(other);
        vm.expectRevert(PluggedAdvancedLedger.OnlyShareToken.selector);
        ledger.setBalance(other, 1 ether);
        vm.prank(other);
        vm.expectRevert(PluggedAdvancedLedger.OnlyController.selector);
        ledger.setExcluded(HOLDER, true);
        vm.expectPartialRevert(PluggedAdvancedLedger.FeedAlreadySet.selector);
        ledger.initFeed(address(quote), other);
        ledger.setBalance(other, 2 ether);
        quote.mint(address(ledger), 30_000);
        ledger.credit(address(quote), 30_000);
        skip(1 days);
        uint256 preserved = ledger.withdrawableOf(HOLDER, address(quote));
        assertGt(preserved, 0);
        ledger.setExcluded(HOLDER, true);
        assertEq(ledger.shareOf(HOLDER), 0);
        assertEq(ledger.queueLength(), 1);
        assertEq(ledger.queueAt(0), other);
        ledger.setBalance(HOLDER, 5 ether);
        assertEq(ledger.shareOf(HOLDER), 0);
        (address[] memory currencies, uint256[] memory claims) = ledger.withdrawableBasket(HOLDER);
        assertEq(currencies[0], address(quote));
        assertEq(claims[0], preserved);
        vm.prank(other);
        ledger.renounceAccrual();
        assertEq(ledger.totalShares(), 0);
        assertEq(ledger.queueLength(), 0);
        assertEq(ledger.processBatch(5), 0);
        vm.prank(other);
        vm.expectRevert(PluggedAdvancedLedger.AlreadyExcluded.selector);
        ledger.renounceAccrual();
        vm.prank(HOLDER);
        ledger.withdrawOne(address(quote));
        assertEq(quote.balanceOf(HOLDER), preserved);
    }
}
