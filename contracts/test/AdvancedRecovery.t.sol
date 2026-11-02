// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AdvancedHarness} from "./AdvancedFactory.t.sol";
import {MockBlacklistERC20} from "carbon/test/mocks/MockERC20.sol";
import {MockAggregatorV3} from "carbon/test/mocks/MockAggregatorV3.sol";
import {FeeHook} from "carbon/src/FeeHook.sol";
import {BasketLedger} from "carbon/src/multi/BasketLedger.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PluggedAdvancedToken} from "../src/PluggedAdvancedToken.sol";
import {PluggedAdvancedFactory} from "../src/PluggedAdvancedFactory.sol";
import {PluggedAdvancedFeed} from "../src/PluggedAdvancedFeed.sol";
import {PluggedAdvancedSplitter} from "../src/PluggedAdvancedSplitter.sol";
import {PluggedFeeSplitter} from "../src/PluggedFeeSplitter.sol";

/// @dev Additional adversarial quote: the exact Carbon blacklist mock plus transfer callbacks.
contract AdvancedRecoveryCallbackQuote is MockBlacklistERC20 {
    address private _target;
    bytes private _secondCall;
    bool private _armed;
    bytes4 public recoverError;
    bytes4 public secondError;

    constructor() MockBlacklistERC20("Callback quote", "CQ", 6) {}

    function arm(address target, bytes calldata secondCall) external {
        _target = target;
        _secondCall = secondCall;
        _armed = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool result = super.transfer(to, amount);
        if (_armed && to == _target) {
            _armed = false;
            (bool ok, bytes memory reason) = _target.call(abi.encodeWithSignature("recoverStuckFees()"));
            require(!ok && reason.length >= 4, "reentrant recovery was not rejected");
            recoverError = bytes4(reason);
            (ok, reason) = _target.call(_secondCall);
            require(!ok && reason.length >= 4, "cross-function reentrancy was not rejected");
            secondError = bytes4(reason);
        }
        return result;
    }
}

/// @notice Reproduces the actual Carbon hook deferral path using its exact blacklist mock.
contract AdvancedRecoveryTest is AdvancedHarness {
    using PoolIdLibrary for PoolKey;

    address internal constant CALLER = address(0xBAD);
    MockBlacklistERC20 internal quote;
    PluggedAdvancedToken internal token;
    BasketLedger internal ledger;
    PluggedAdvancedFeed internal feed;
    PluggedAdvancedSplitter internal splitter;
    PoolKey internal key;

    function setUp() public override {
        super.setUp();
        quote = new MockBlacklistERC20("Blacklist quote", "BQ", 6);
        MockAggregatorV3 oracle = new MockAggregatorV3(8, 1e8, "BQ/USD");
        quotes[0] = address(quote);
        pairs.approvePair(address(quote), address(oracle), 1 days, 6);
        quote.mint(CREATOR, 100_000e6);
        vm.prank(CREATOR);
        quote.approve(address(factory), type(uint256).max);
        token = _launch(_params(1));
        ledger = token.ledger();
        feed = PluggedAdvancedFeed(ledger.feedOf(address(quote)));
        splitter = PluggedAdvancedSplitter(payable(factory.splitterOf(address(token), address(quote))));
        key = _key(address(token), address(quote));
        assertEq(feed.hook(), address(hook));
        assertEq(splitter.hook(), address(hook));
        assertEq(address(feed.ledger()), address(ledger));
        assertEq(feed.currency(), address(quote));
        assertEq(splitter.currency(), address(quote));
    }

    function _deferBoth() internal returns (uint256 holderFees, uint256 creatorFees, uint256 charged) {
        charged = hook.pendingFees(key.toId());
        assertGt(charged, 0, "must exercise a real funded fee sweep");
        quote.addBlackList(address(feed));
        quote.addBlackList(address(splitter));
        hook.sweep(key);
        holderFees = hook.stuckFeesOf(address(quote), address(feed));
        creatorFees = hook.stuckFeesOf(address(quote), address(splitter));
        assertGt(holderFees, 0);
        assertGt(creatorFees, 0);
        assertEq(hook.stuckTotal(address(quote)), holderFees + creatorFees);
        assertEq(quote.balanceOf(address(hook)), holderFees + creatorFees);
        assertEq(quote.balanceOf(address(feed)), 0);
        assertEq(quote.balanceOf(address(ledger)), 0);
        assertEq(splitter.totalReceived(), 0);
        assertEq(splitter.claimable(ALICE), 0);
        assertEq(
            holderFees + creatorFees + quote.balanceOf(PLATFORM) + quote.balanceOf(address(this)), charged
        );
    }

    function testPermissionlessRecoveryConservesLiabilitiesAndPaysOriginalRecipients() public {
        (uint256 holderFees, uint256 creatorFees, uint256 charged) = _deferBoth();
        vm.prank(CALLER);
        vm.expectRevert(FeeHook.ClaimTransferFailed.selector);
        feed.recoverStuckFees();
        vm.prank(CALLER);
        vm.expectRevert(FeeHook.ClaimTransferFailed.selector);
        splitter.recoverStuckFees();
        assertEq(hook.stuckTotal(address(quote)), holderFees + creatorFees);

        quote.removeBlackList(address(feed));
        quote.removeBlackList(address(splitter));
        vm.prank(CALLER);
        assertEq(feed.recoverStuckFees(), holderFees);
        assertEq(hook.stuckFeesOf(address(quote), address(feed)), 0);
        assertEq(hook.stuckTotal(address(quote)), creatorFees);
        assertEq(quote.balanceOf(address(ledger)), holderFees);
        assertEq(quote.balanceOf(address(feed)), 0);
        assertEq(
            ledger.withdrawableOf(CREATOR, address(quote)), 0, "recovery starts a stream, not a lump payout"
        );

        vm.prank(CALLER);
        assertEq(splitter.recoverStuckFees(), creatorFees);
        assertEq(hook.stuckFeesOf(address(quote), address(splitter)), 0);
        assertEq(hook.stuckTotal(address(quote)), 0);
        assertEq(quote.balanceOf(address(hook)), 0);
        assertEq(splitter.totalReceived(), creatorFees);
        uint256 aliceClaim = splitter.claimable(ALICE);
        uint256 bobClaim = splitter.claimable(BOB);
        assertGt(aliceClaim, 0);
        assertGt(bobClaim, 0);
        vm.startPrank(CALLER);
        splitter.release(ALICE);
        splitter.release(BOB);
        vm.stopPrank();
        assertEq(quote.balanceOf(ALICE), aliceClaim);
        assertEq(quote.balanceOf(BOB), bobClaim);
        assertEq(quote.balanceOf(CALLER), 0);
        assertEq(aliceClaim + bobClaim + quote.balanceOf(address(splitter)), creatorFees);
        assertEq(splitter.totalReleased(), aliceClaim + bobClaim);

        skip(1 days);
        uint256 holderClaim = ledger.withdrawableOf(CREATOR, address(quote));
        assertGt(holderClaim, 0);
        uint256 beforeCreator = quote.balanceOf(CREATOR);
        vm.prank(CREATOR);
        ledger.withdrawOne(address(quote));
        assertEq(quote.balanceOf(CREATOR) - beforeCreator, holderClaim);
        assertEq(holderClaim + quote.balanceOf(address(ledger)), holderFees);
        assertEq(ledger.totalDistributedOf(address(quote)), holderFees);
        assertEq(ledger.totalWithdrawnOf(address(quote)), holderClaim);
        assertEq(
            holderClaim + aliceClaim + bobClaim + quote.balanceOf(address(ledger))
                + quote.balanceOf(address(splitter)) + quote.balanceOf(PLATFORM)
                + quote.balanceOf(address(this)),
            charged
        );
        vm.expectRevert(FeeHook.NothingStuck.selector);
        feed.recoverStuckFees();
        vm.expectRevert(FeeHook.NothingStuck.selector);
        splitter.recoverStuckFees();
    }

    function testBlockedLedgerRevertsRecoveryAndRestoresCarbonLiability() public {
        (uint256 holderFees, uint256 creatorFees,) = _deferBoth();
        quote.removeBlackList(address(feed));
        quote.addBlackList(address(ledger));
        vm.prank(CALLER);
        vm.expectRevert(abi.encodeWithSelector(MockBlacklistERC20.Blacklisted.selector, address(ledger)));
        feed.recoverStuckFees();
        assertEq(hook.stuckFeesOf(address(quote), address(feed)), holderFees);
        assertEq(hook.stuckTotal(address(quote)), holderFees + creatorFees);
        assertEq(quote.balanceOf(address(hook)), holderFees + creatorFees);
        assertEq(quote.balanceOf(address(feed)), 0);
        assertEq(quote.balanceOf(address(ledger)), 0);
        quote.removeBlackList(address(ledger));
        feed.recoverStuckFees();
        assertEq(quote.balanceOf(address(ledger)), holderFees);
        assertEq(hook.stuckTotal(address(quote)), creatorFees);
    }

    function testRecoveryCannotSelectHookCurrencyOrRedirectRecipient() public {
        (uint256 holderFees, uint256 creatorFees,) = _deferBoth();
        quote.removeBlackList(address(feed));
        quote.removeBlackList(address(splitter));
        vm.startPrank(CALLER);
        vm.expectRevert(FeeHook.NothingStuck.selector);
        hook.claimStuckFees(address(quote));
        vm.expectRevert(PluggedAdvancedFeed.OnlyHook.selector);
        feed.distribute(holderFees);
        (bool feedRedirect,) =
            address(feed).call(abi.encodeWithSignature("recoverStuckFees(address)", CALLER));
        (bool splitterRedirect,) =
            address(splitter).call(abi.encodeWithSignature("recoverStuckFees(address)", CALLER));
        assertFalse(feedRedirect);
        assertFalse(splitterRedirect);
        feed.recoverStuckFees();
        splitter.recoverStuckFees();
        vm.expectRevert(PluggedFeeSplitter.NothingToClaim.selector);
        splitter.release(CALLER);
        vm.stopPrank();
        assertEq(quote.balanceOf(CALLER), 0);
        assertEq(quote.balanceOf(address(ledger)), holderFees);
        assertEq(splitter.totalReceived(), creatorFees);
    }

    function testBlockedLedgerRollsBackSweepAndDirectFundsRemainSyncable() public {
        uint256 pending = hook.pendingFees(key.toId());
        assertGt(pending, 0);
        quote.addBlackList(address(ledger));
        // Carbon _routeFee directly calls distribute: a failed forward reverts the whole sweep,
        // unlike a failed initial transfer, which books stuckFees. Both paths must conserve funds.
        vm.expectRevert(abi.encodeWithSelector(MockBlacklistERC20.Blacklisted.selector, address(ledger)));
        hook.sweep(key);
        assertEq(hook.pendingFees(key.toId()), pending);
        assertEq(splitter.totalReceived(), 0);
        assertEq(quote.balanceOf(address(feed)), 0);
        assertEq(hook.stuckFeesOf(address(quote), address(feed)), 0);
        assertEq(quote.balanceOf(address(ledger)), 0);
        uint256 donation = 123_456;
        quote.mint(address(feed), donation);
        vm.expectRevert(abi.encodeWithSelector(MockBlacklistERC20.Blacklisted.selector, address(ledger)));
        feed.sync();
        assertEq(quote.balanceOf(address(feed)), donation);
        quote.removeBlackList(address(ledger));
        vm.prank(CALLER);
        feed.sync();
        assertEq(quote.balanceOf(address(feed)), 0);
        assertEq(quote.balanceOf(address(ledger)), donation);
        assertEq(quote.balanceOf(CALLER), 0);
        hook.sweep(key);
        assertEq(hook.pendingFees(key.toId()), 0);
        assertGt(quote.balanceOf(address(ledger)), donation);
    }

    function testRecoveryRejectsTransferCallbackReentryAcrossAllMoneyPaths() public {
        AdvancedRecoveryCallbackQuote callbackQuote = new AdvancedRecoveryCallbackQuote();
        quote = callbackQuote;
        quotes[0] = address(quote);
        pairs.approvePairWithoutOracle(address(quote), 6);
        quote.mint(CREATOR, 100_000e6);
        vm.prank(CREATOR);
        quote.approve(address(factory), type(uint256).max);
        // The first launch used the setup salt; this is a separate quote and token.
        PluggedAdvancedFactory.LaunchParams memory p = _params(1);
        p.salt = bytes32(uint256(2));
        token = _launch(p);
        ledger = token.ledger();
        feed = PluggedAdvancedFeed(ledger.feedOf(address(quote)));
        splitter = PluggedAdvancedSplitter(payable(factory.splitterOf(address(token), address(quote))));
        key = _key(address(token), address(quote));
        (uint256 holderFees, uint256 creatorFees,) = _deferBoth();
        quote.removeBlackList(address(feed));
        quote.removeBlackList(address(splitter));
        bytes4 guard = bytes4(keccak256("ReentrancyGuardReentrantCall()"));
        callbackQuote.arm(address(feed), abi.encodeWithSignature("sync()"));
        feed.recoverStuckFees();
        assertEq(callbackQuote.recoverError(), guard);
        assertEq(callbackQuote.secondError(), guard);
        assertEq(quote.balanceOf(address(ledger)), holderFees);
        callbackQuote.arm(address(splitter), abi.encodeWithSignature("release(address)", ALICE));
        splitter.recoverStuckFees();
        assertEq(callbackQuote.recoverError(), guard);
        assertEq(callbackQuote.secondError(), guard);
        assertEq(splitter.totalReceived(), creatorFees);
        assertEq(splitter.totalReleased(), 0);
        assertEq(quote.balanceOf(ALICE), 0);
        assertEq(hook.stuckTotal(address(quote)), 0);
    }
}
