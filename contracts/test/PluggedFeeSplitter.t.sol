// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PluggedFeeSplitter} from "../src/PluggedFeeSplitter.sol";

contract QuoteToken is ERC20 {
    bool public tax;
    constructor() ERC20("Quote", "QUOTE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTax(bool enabled) external {
        tax = enabled;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (tax && from != address(0) && to != address(0)) {
            uint256 charge = value / 100;
            super._update(from, address(0), charge);
            value -= charge;
        }
        super._update(from, to, value);
    }
}

contract RejectNative {
    receive() external payable {
        revert();
    }
}

contract ReenterNative {
    PluggedFeeSplitter public splitter;
    bool public blocked;

    function setSplitter(PluggedFeeSplitter value) external {
        splitter = value;
    }

    receive() external payable {
        try splitter.release(address(this)) {
            blocked = false;
        } catch {
            blocked = true;
        }
    }
}

contract PluggedFeeSplitterTest is Test {
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address outsider = address(0xCA11);
    QuoteToken quote;
    PluggedFeeSplitter splitter;

    function setupSplit(address currency, address a, address b, uint16 share)
        internal
        returns (PluggedFeeSplitter)
    {
        address[] memory recipients = new address[](2);
        recipients[0] = a;
        recipients[1] = b;
        uint16[] memory bps = new uint16[](2);
        bps[0] = share;
        bps[1] = 10000 - share;
        return new PluggedFeeSplitter(currency, recipients, bps, keccak256("draft"));
    }

    function setUp() public {
        quote = new QuoteToken();
        splitter = setupSplit(address(quote), alice, bob, 7000);
    }

    function test_DirectHookTransferIsClaimableWithoutDepositCall() public {
        quote.mint(address(this), 100e6);
        assertTrue(quote.transfer(address(splitter), 100e6));
        assertEq(splitter.totalReceived(), 100e6);
        assertEq(splitter.claimable(alice), 70e6);
        assertEq(splitter.claimable(bob), 30e6);
        assertEq(splitter.recipientCount(), 2);
        assertEq(splitter.recipients(0), alice);
        assertEq(splitter.planHash(), keccak256("draft"));
    }

    function test_AnyoneCanTriggerButCannotRedirectPayout() public {
        quote.mint(address(splitter), 100e6);
        vm.prank(outsider);
        splitter.release(alice);
        assertEq(quote.balanceOf(alice), 70e6);
        assertEq(quote.balanceOf(outsider), 0);
        assertEq(splitter.claimable(alice), 0);
        assertEq(splitter.totalReleased(), 70e6);
    }

    function test_RejectsRepeatedClaimAndUnknownRecipient() public {
        quote.mint(address(splitter), 100);
        assertGt(splitter.claimable(alice), 0);
        splitter.release(alice);
        vm.expectRevert(PluggedFeeSplitter.NothingToClaim.selector);
        splitter.release(alice);
        vm.expectRevert(PluggedFeeSplitter.NothingToClaim.selector);
        splitter.release(outsider);
    }

    function test_DustAccumulatesAcrossDeposits() public {
        quote.mint(address(splitter), 1);
        assertEq(splitter.claimable(alice), 0);
        quote.mint(address(splitter), 9);
        splitter.release(alice);
        splitter.release(bob);
        assertEq(quote.balanceOf(alice), 7);
        assertEq(quote.balanceOf(bob), 3);
        assertEq(quote.balanceOf(address(splitter)), 0);
    }

    function test_NativeClaimsAndRejectingReceiverIsolation() public {
        RejectNative reject = new RejectNative();
        PluggedFeeSplitter nativeSplit = setupSplit(address(0), address(reject), bob, 7000);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(nativeSplit).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(nativeSplit.claimable(address(reject)), 0.7 ether);
        vm.expectRevert(PluggedFeeSplitter.NativePaymentFailed.selector);
        nativeSplit.release(address(reject));
        assertEq(nativeSplit.released(address(reject)), 0);
        nativeSplit.release(bob);
        assertEq(bob.balance, 0.3 ether);
        assertEq(address(nativeSplit).balance, 0.7 ether);
    }

    function test_NativeReentrancyIsBlocked() public {
        ReenterNative receiver = new ReenterNative();
        PluggedFeeSplitter nativeSplit = setupSplit(address(0), address(receiver), bob, 7000);
        receiver.setSplitter(nativeSplit);
        vm.deal(address(nativeSplit), 1 ether);
        nativeSplit.release(address(receiver));
        assertTrue(receiver.blocked());
        assertEq(address(receiver).balance, 0.7 ether);
        assertEq(nativeSplit.totalReleased(), 0.7 ether);
        assertEq(nativeSplit.claimable(address(receiver)), 0);
    }

    function test_TaxedTransferRevertsWithoutDebitingRecipient() public {
        quote.mint(address(splitter), 100e6);
        quote.setTax(true);
        assertEq(splitter.claimable(alice), 70e6);
        vm.expectRevert(PluggedFeeSplitter.UnsupportedTokenBehavior.selector);
        splitter.release(alice);
        assertEq(splitter.released(alice), 0);
        assertEq(splitter.totalReleased(), 0);
        assertEq(quote.balanceOf(address(splitter)), 100e6);
        assertEq(quote.balanceOf(alice), 0);
    }

    function test_RejectsNativeForERC20Pool() public {
        vm.deal(address(this), 1);
        (bool ok,) = address(splitter).call{value: 1}("");
        assertFalse(ok);
    }

    function test_RejectsDuplicateRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeSplitter.DuplicateRecipient.selector, alice));
        setupSplit(address(quote), alice, alice, 5000);
    }

    function test_RejectsZeroRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeSplitter.InvalidRecipient.selector, address(0)));
        setupSplit(address(quote), address(0), bob, 5000);
    }

    function test_RejectsNonContractCurrency() public {
        vm.expectRevert(PluggedFeeSplitter.InvalidCurrency.selector);
        setupSplit(outsider, alice, bob, 5000);
    }

    function test_RejectsZeroShare() public {
        vm.expectRevert(PluggedFeeSplitter.InvalidShares.selector);
        setupSplit(address(quote), alice, bob, 0);
    }

    function test_RejectsEmptyAndOversizedAndMismatchedRecipients() public {
        vm.expectRevert(PluggedFeeSplitter.InvalidRecipients.selector);
        new PluggedFeeSplitter(address(quote), new address[](0), new uint16[](0), bytes32(0));
        vm.expectRevert(PluggedFeeSplitter.InvalidRecipients.selector);
        new PluggedFeeSplitter(address(quote), new address[](101), new uint16[](101), bytes32(0));
        vm.expectRevert(PluggedFeeSplitter.InvalidRecipients.selector);
        new PluggedFeeSplitter(address(quote), new address[](2), new uint16[](1), bytes32(0));
    }

    function test_RejectsUnderallocatedAndOverallocatedShares() public {
        address[] memory recipients = new address[](1);
        recipients[0] = alice;
        uint16[] memory bps = new uint16[](1);
        bps[0] = 9999;
        vm.expectRevert(PluggedFeeSplitter.InvalidShares.selector);
        new PluggedFeeSplitter(address(quote), recipients, bps, bytes32(0));
        bps[0] = 10001;
        vm.expectRevert(PluggedFeeSplitter.InvalidShares.selector);
        new PluggedFeeSplitter(address(quote), recipients, bps, bytes32(0));
    }

    function test_HundredRecipientsClaimIndependently() public {
        address[] memory recipients = new address[](100);
        uint16[] memory bps = new uint16[](100);
        for (uint256 i; i < 100; ++i) {
            // i < 100, so i + 100 <= 199 and the address conversion is lossless.
            // forge-lint: disable-next-line(unsafe-typecast)
            recipients[i] = address(uint160(i + 100));
            bps[i] = 100;
        }
        PluggedFeeSplitter large = new PluggedFeeSplitter(address(quote), recipients, bps, bytes32(0));
        quote.mint(address(large), 10000);
        for (uint256 i; i < 100; ++i) {
            large.release(recipients[i]);
            assertEq(quote.balanceOf(recipients[i]), 100);
        }
        assertEq(quote.balanceOf(address(large)), 0);
    }

    function testFuzz_ClaimOrderingConservesFunds(uint128 first, uint128 second, uint16 rawShare) public {
        uint16 share = uint16(bound(rawShare, 1, 9999));
        PluggedFeeSplitter split = setupSplit(address(quote), alice, bob, share);
        quote.mint(address(split), first);
        if (split.claimable(alice) > 0) split.release(alice);
        quote.mint(address(split), second);
        if (split.claimable(bob) > 0) split.release(bob);
        if (split.claimable(alice) > 0) split.release(alice);
        uint256 total = uint256(first) + second;
        assertEq(quote.balanceOf(alice), total * share / 10000);
        assertEq(quote.balanceOf(bob), total * (10000 - share) / 10000);
        assertEq(quote.balanceOf(alice) + quote.balanceOf(bob) + quote.balanceOf(address(split)), total);
        assertLe(quote.balanceOf(address(split)), 1);
        assertEq(split.totalReceived(), total);
    }
}

contract SplitHandler is Test {
    PluggedFeeSplitter public splitter;
    QuoteToken public quote;
    uint256 public funded;
    address public alice = address(0xA11CE);
    address public bob = address(0xB0B);

    constructor(PluggedFeeSplitter split, QuoteToken token) {
        splitter = split;
        quote = token;
    }

    function deposit(uint96 amount) external {
        quote.mint(address(splitter), amount);
        funded += amount;
    }

    function claim(bool first) external {
        address recipient = first ? alice : bob;
        if (splitter.claimable(recipient) > 0) splitter.release(recipient);
    }
}

contract SplitInvariantTest is StdInvariant, Test {
    SplitHandler handler;
    PluggedFeeSplitter splitter;
    QuoteToken quote;

    function setUp() public {
        quote = new QuoteToken();
        address[] memory recipients = new address[](2);
        recipients[0] = address(0xA11CE);
        recipients[1] = address(0xB0B);
        uint16[] memory bps = new uint16[](2);
        bps[0] = 7000;
        bps[1] = 3000;
        splitter = new PluggedFeeSplitter(address(quote), recipients, bps, bytes32(0));
        handler = new SplitHandler(splitter, quote);
        targetContract(address(handler));
    }

    function invariant_ConservationAndSolvency() public view {
        uint256 paid = quote.balanceOf(address(0xA11CE)) + quote.balanceOf(address(0xB0B));
        uint256 held = quote.balanceOf(address(splitter));
        assertEq(paid + held, handler.funded());
        assertEq(splitter.totalReleased(), paid);
        assertLe(splitter.claimable(address(0xA11CE)) + splitter.claimable(address(0xB0B)), held);
    }
}
