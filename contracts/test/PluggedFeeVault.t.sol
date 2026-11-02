// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PluggedFeeVault, PluggedFeeVaultInbox} from "../src/PluggedFeeVault.sol";
import {PluggedFeeSplitter} from "../src/PluggedFeeSplitter.sol";

contract VaultToken is ERC20 {
    constructor() ERC20("Vault Quote", "VQ") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract TaxToken is ERC20 {
    constructor() ERC20("Tax", "TAX") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xdead), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// Calls back into the vault on every transfer, simulating a hook token.
contract HookToken is ERC20 {
    PluggedFeeVault public vault;
    uint256 public target;
    bytes public payload;
    bool public reentered;
    bool public lastSucceeded;

    constructor() ERC20("Hook", "HK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(PluggedFeeVault vault_, bytes calldata payload_) external {
        vault = vault_;
        payload = payload_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(vault) != address(0) && from == address(vault) && !reentered) {
            reentered = true;
            (lastSucceeded,) = address(vault).call(payload);
        }
    }
}

contract ReentrantReceiver {
    PluggedFeeVault public vault;
    bytes public payload;
    bool public attempted;
    bool public succeeded;

    function setup(PluggedFeeVault vault_, bytes calldata payload_) external {
        vault = vault_;
        payload = payload_;
    }

    function call(bytes calldata data) external returns (bytes memory out) {
        bool ok;
        (ok, out) = address(vault).call(data);
        require(ok, "call failed");
    }

    receive() external payable {
        if (!attempted) {
            attempted = true;
            (succeeded,) = address(vault).call(payload);
        }
    }
}

contract RejectingReceiver {
    function call(PluggedFeeVault vault, bytes calldata data) external {
        (bool ok, bytes memory out) = address(vault).call(data);
        if (!ok) {
            assembly {
                revert(add(out, 32), mload(out))
            }
        }
    }
}

contract PluggedFeeVaultTest is Test {
    PluggedFeeVault vault;
    VaultToken token;
    address creator = makeAddr("creator");
    address dev = makeAddr("dev");
    address operator = makeAddr("operator");
    address outsider = makeAddr("outsider");
    bytes32 constant REF = keccak256("github:octocat");

    function setUp() public {
        vault = new PluggedFeeVault();
        token = new VaultToken();
        token.mint(address(this), 1e30);
        token.approve(address(vault), type(uint256).max);
        vm.deal(address(this), 1e24);
    }

    function _create(address currency, uint256 window, address op) internal returns (uint256 id, address inbox) {
        vm.prank(creator);
        (id, inbox) = vault.createContainer(dev, currency, window, op, REF);
    }

    function _fund(uint256 id, uint256 amount) internal {
        vault.deposit(id, amount);
    }

    // ------------------------------------------------------------- creation

    function test_create_defaults() public {
        (uint256 id, address inbox) = _create(address(token), 0, address(0));
        PluggedFeeVault.Container memory c = vault.getContainer(id);
        assertEq(id, 1);
        assertEq(c.allocator, creator);
        assertEq(c.recipient, dev);
        assertEq(c.inbox, inbox);
        assertEq(uint256(c.deadline), block.timestamp + 30 days);
        assertEq(uint256(c.state), uint256(PluggedFeeVault.State.PENDING));
        assertEq(PluggedFeeVaultInbox(payable(inbox)).vault(), address(vault));
        assertTrue(vault.isInbox(inbox));
        assertEq(vault.recipientContainers(dev, 0, 10)[0], 1);
        assertEq(vault.allocatorContainers(creator, 0, 10)[0], 1);
    }

    function test_create_windowBounds() public {
        vm.startPrank(creator);
        vm.expectRevert(PluggedFeeVault.InvalidWindow.selector);
        vault.createContainer(dev, address(token), 7 days - 1, address(0), REF);
        vm.expectRevert(PluggedFeeVault.InvalidWindow.selector);
        vault.createContainer(dev, address(token), 365 days + 1, address(0), REF);
        vault.createContainer(dev, address(token), 7 days, address(0), REF);
        vault.createContainer(dev, address(token), 365 days, address(0), REF);
        vm.expectRevert(PluggedFeeVault.InvalidRecipient.selector);
        vault.createContainer(address(0), address(token), 0, address(0), REF);
        vm.expectRevert(PluggedFeeVault.InvalidRecipient.selector);
        vault.createContainer(creator, address(token), 0, address(0), REF);
        vm.expectRevert(PluggedFeeVault.InvalidCurrency.selector);
        vault.createContainer(dev, makeAddr("eoa"), 0, address(0), REF);
        vm.stopPrank();
    }

    // ------------------------------------------------------------- accept / claim

    function test_accept_thenClaimAccruedAndFuture() public {
        (uint256 id, address inbox) = _create(address(token), 0, address(0));
        _fund(id, 100e18);
        vm.prank(dev);
        vault.accept(id);
        token.transfer(inbox, 50e18); // future funds via inbox
        assertEq(vault.claimable(id), 150e18);
        vm.prank(dev);
        assertEq(vault.claim(id), 150e18);
        assertEq(token.balanceOf(dev), 150e18);
        assertEq(vault.totalHeld(address(token)), 0);
        vm.prank(dev);
        vm.expectRevert(PluggedFeeVault.NothingToPay.selector);
        vault.claim(id);
    }

    function test_noClawbackAfterAccept() public {
        (uint256 id,) = _create(address(token), 7 days, operator);
        _fund(id, 10e18);
        vm.prank(dev);
        vault.accept(id);
        vm.warp(block.timestamp + 400 days);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.ACCEPTED));
        vault.reclaim(id);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.ACCEPTED));
        vault.operatorReturn(id);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.ACCEPTED));
        vault.extendDeadline(id, uint40(block.timestamp + 1 days));
        vm.prank(dev);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.ACCEPTED));
        vault.decline(id);
        vm.prank(dev);
        assertEq(vault.claim(id), 10e18);
    }

    function test_unauthorizedCallers() public {
        (uint256 id,) = _create(address(token), 0, operator);
        _fund(id, 1e18);
        vm.startPrank(outsider);
        vm.expectRevert(PluggedFeeVault.Unauthorized.selector);
        vault.accept(id);
        vm.expectRevert(PluggedFeeVault.Unauthorized.selector);
        vault.decline(id);
        vm.expectRevert(PluggedFeeVault.Unauthorized.selector);
        vault.claim(id);
        vm.expectRevert(PluggedFeeVault.Unauthorized.selector);
        vault.reclaim(id);
        vm.expectRevert(PluggedFeeVault.Unauthorized.selector);
        vault.operatorReturn(id);
        vm.expectRevert(PluggedFeeVault.Unauthorized.selector);
        vault.extendDeadline(id, uint40(block.timestamp + 40 days));
        vm.stopPrank();
        // allocator cannot act as recipient or operator
        vm.startPrank(creator);
        vm.expectRevert(PluggedFeeVault.Unauthorized.selector);
        vault.accept(id);
        vm.expectRevert(PluggedFeeVault.Unauthorized.selector);
        vault.operatorReturn(id);
        vm.stopPrank();
        // recipient cannot reclaim
        vm.prank(dev);
        vm.expectRevert(PluggedFeeVault.Unauthorized.selector);
        vault.reclaim(id);
        // inbox is vault-only
        address inbox = vault.getContainer(id).inbox;
        vm.prank(outsider);
        vm.expectRevert(PluggedFeeVaultInbox.OnlyVault.selector);
        PluggedFeeVaultInbox(payable(inbox)).forward();
        vm.expectRevert(PluggedFeeVault.UnknownContainer.selector);
        vault.status(99);
    }

    function test_claimBeforeAccept_reverts() public {
        (uint256 id,) = _create(address(token), 0, address(0));
        _fund(id, 1e18);
        vm.prank(dev);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.PENDING));
        vault.claim(id);
    }

    // ------------------------------------------------------------- decline / expiry / reclaim

    function test_decline_thenReclaimImmediately_andLaterInflows() public {
        (uint256 id, address inbox) = _create(address(token), 0, address(0));
        _fund(id, 40e18);
        vm.prank(dev);
        vault.decline(id);
        vm.prank(dev);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.DECLINED));
        vault.accept(id);
        vm.prank(creator);
        assertEq(vault.reclaim(id), 40e18);
        assertEq(token.balanceOf(creator), 40e18);
        assertEq(uint256(vault.status(id)), uint256(PluggedFeeVault.State.RECLAIMED));
        token.transfer(inbox, 5e18);
        assertEq(vault.reclaimable(id), 5e18);
        vm.prank(creator);
        assertEq(vault.reclaim(id), 5e18);
        vm.prank(creator);
        vm.expectRevert(PluggedFeeVault.NothingToPay.selector);
        vault.reclaim(id);
    }

    function test_expiryBoundary() public {
        (uint256 id,) = _create(address(token), 7 days, address(0));
        _fund(id, 1e18);
        uint256 deadline = vault.getContainer(id).deadline;
        vm.warp(deadline - 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.PENDING));
        vault.reclaim(id);
        assertEq(vault.reclaimable(id), 0);
        vm.warp(deadline);
        assertEq(uint256(vault.status(id)), uint256(PluggedFeeVault.State.EXPIRED));
        vm.prank(dev);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.EXPIRED));
        vault.accept(id);
        vm.prank(dev);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.EXPIRED));
        vault.decline(id);
        vm.prank(creator);
        assertEq(vault.reclaim(id), 1e18);
    }

    function test_acceptAtLastSecond() public {
        (uint256 id,) = _create(address(token), 7 days, address(0));
        _fund(id, 1e18);
        vm.warp(vault.getContainer(id).deadline - 1);
        vm.prank(dev);
        vault.accept(id);
        vm.warp(block.timestamp + 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.ACCEPTED));
        vault.reclaim(id);
    }

    function test_declineAcceptRace() public {
        (uint256 id,) = _create(address(token), 0, address(0));
        _fund(id, 1e18);
        vm.prank(dev);
        vault.decline(id);
        vm.prank(dev);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.DECLINED));
        vault.accept(id);
        (uint256 id2,) = _create(address(token), 0, address(0));
        vm.prank(dev);
        vault.accept(id2);
        vm.prank(dev);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.ACCEPTED));
        vault.decline(id2);
    }

    // ------------------------------------------------------------- operator

    function test_operatorExtendAndReturn() public {
        (uint256 id,) = _create(address(token), 7 days, operator);
        _fund(id, 3e18);
        uint40 d = vault.getContainer(id).deadline;
        vm.prank(operator);
        vm.expectRevert(PluggedFeeVault.InvalidDeadline.selector);
        vault.extendDeadline(id, d);
        vm.prank(operator);
        vm.expectRevert(PluggedFeeVault.InvalidDeadline.selector);
        vault.extendDeadline(id, uint40(block.timestamp + 365 days + 1));
        vm.prank(operator);
        vault.extendDeadline(id, d + 10 days);
        assertEq(vault.getContainer(id).deadline, d + 10 days);
        vm.prank(creator);
        vault.extendDeadline(id, d + 20 days);
        vm.prank(operator);
        assertEq(vault.operatorReturn(id), 3e18);
        assertEq(token.balanceOf(creator), 3e18);
        assertEq(token.balanceOf(operator), 0);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.RECLAIMED));
        vault.extendDeadline(id, d + 30 days);
        vm.prank(dev);
        vm.expectRevert(abi.encodeWithSelector(PluggedFeeVault.InvalidState.selector, PluggedFeeVault.State.RECLAIMED));
        vault.accept(id);
    }

    function test_noOperatorMeansNoOperatorPowers() public {
        (uint256 id,) = _create(address(token), 0, address(0));
        vm.prank(address(0));
        vm.expectRevert(PluggedFeeVault.Unauthorized.selector);
        vault.operatorReturn(id);
    }

    // ------------------------------------------------------------- native ETH

    function test_native_fullCycle() public {
        (uint256 id, address inbox) = _create(address(0), 0, address(0));
        vault.depositNative{value: 1 ether}(id);
        (bool ok,) = inbox.call{value: 2 ether}("");
        assertTrue(ok);
        (bool direct,) = address(vault).call{value: 1}("");
        assertFalse(direct);
        vm.expectRevert(PluggedFeeVault.InvalidCurrency.selector);
        vault.deposit(id, 1);
        vm.prank(dev);
        vault.accept(id);
        vm.prank(dev);
        assertEq(vault.claim(id), 3 ether);
        assertEq(dev.balance, 3 ether);
        assertEq(address(vault).balance, 0);
    }

    function test_native_wrongCurrencyRejected() public {
        (uint256 id, address inbox) = _create(address(token), 0, address(0));
        vm.expectRevert(PluggedFeeVault.InvalidCurrency.selector);
        vault.depositNative{value: 1}(id);
        (bool ok,) = inbox.call{value: 1}("");
        assertFalse(ok);
    }

    function test_native_rejectingRecipientKeepsFunds() public {
        RejectingReceiver bad = new RejectingReceiver();
        vm.prank(creator);
        (uint256 id,) = vault.createContainer(address(bad), address(0), 0, address(0), REF);
        vault.depositNative{value: 1 ether}(id);
        bad.call(vault, abi.encodeCall(PluggedFeeVault.accept, (id)));
        vm.expectRevert(PluggedFeeVault.NativePaymentFailed.selector);
        bad.call(vault, abi.encodeCall(PluggedFeeVault.claim, (id)));
        assertEq(vault.getContainer(id).balance, 1 ether);
        assertEq(address(vault).balance, 1 ether);
    }

    // ------------------------------------------------------------- token behaviour

    function test_feeOnTransferRejected() public {
        TaxToken tax = new TaxToken();
        tax.mint(address(this), 1e24);
        tax.approve(address(vault), type(uint256).max);
        (uint256 id, address inbox) = _create(address(tax), 0, address(0));
        vm.expectRevert(PluggedFeeVault.UnsupportedTokenBehavior.selector);
        vault.deposit(id, 100e18);
        tax.transfer(inbox, 100e18);
        vm.expectRevert(PluggedFeeVault.UnsupportedTokenBehavior.selector);
        vault.sweepInbox(id);
        assertEq(vault.totalHeld(address(tax)), 0);
    }

    // ------------------------------------------------------------- reentrancy

    function test_reentrancy_nativeClaim() public {
        ReentrantReceiver r = new ReentrantReceiver();
        vm.prank(creator);
        (uint256 id,) = vault.createContainer(address(r), address(0), 0, address(0), REF);
        vault.depositNative{value: 1 ether}(id);
        r.setup(vault, abi.encodeCall(PluggedFeeVault.claim, (id)));
        r.call(abi.encodeCall(PluggedFeeVault.accept, (id)));
        r.call(abi.encodeCall(PluggedFeeVault.claim, (id)));
        assertTrue(r.attempted());
        assertFalse(r.succeeded());
        assertEq(address(r).balance, 1 ether);
        assertEq(address(vault).balance, 0);
    }

    function test_reentrancy_nativeReclaim() public {
        ReentrantReceiver r = new ReentrantReceiver();
        vm.prank(address(r));
        (uint256 id,) = vault.createContainer(dev, address(0), 7 days, address(0), REF);
        vault.depositNative{value: 1 ether}(id);
        r.setup(vault, abi.encodeCall(PluggedFeeVault.reclaim, (id)));
        vm.warp(block.timestamp + 7 days);
        r.call(abi.encodeCall(PluggedFeeVault.reclaim, (id)));
        assertFalse(r.succeeded());
        assertEq(address(r).balance, 1 ether);
    }

    function test_reentrancy_tokenHook() public {
        HookToken hook = new HookToken();
        hook.mint(address(this), 1e24);
        hook.approve(address(vault), type(uint256).max);
        (uint256 id,) = _create(address(hook), 0, address(0));
        vault.deposit(id, 10e18);
        vm.prank(dev);
        vault.accept(id);
        hook.arm(vault, abi.encodeCall(PluggedFeeVault.sweepInbox, (id)));
        vm.prank(dev);
        vault.claim(id);
        assertTrue(hook.reentered());
        assertFalse(hook.lastSucceeded());
        assertEq(hook.balanceOf(dev), 10e18);
    }

    // ------------------------------------------------------------- splitter integration

    function test_splitterRecipientSlotIsContainerInbox() public {
        (uint256 id, address inbox) = _create(address(token), 0, address(0));
        address[] memory recipients = new address[](2);
        recipients[0] = creator;
        recipients[1] = inbox;
        uint16[] memory bps = new uint16[](2);
        bps[0] = 7000;
        bps[1] = 3000;
        PluggedFeeSplitter splitter = new PluggedFeeSplitter(address(token), recipients, bps, bytes32("plan"));
        token.transfer(address(splitter), 1000e18);
        splitter.release(inbox);
        assertEq(vault.inboxBalance(id), 300e18);
        vm.warp(block.timestamp + 30 days);
        vm.prank(creator);
        assertEq(vault.reclaim(id), 300e18);
        splitter.release(creator);
        assertEq(token.balanceOf(creator), 1000e18);
    }

    function test_nativeSplitterIntoInbox() public {
        (uint256 id, address inbox) = _create(address(0), 0, address(0));
        address[] memory recipients = new address[](1);
        recipients[0] = inbox;
        uint16[] memory bps = new uint16[](1);
        bps[0] = 10000;
        PluggedFeeSplitter splitter = new PluggedFeeSplitter(address(0), recipients, bps, bytes32("plan"));
        (bool ok,) = address(splitter).call{value: 5 ether}("");
        assertTrue(ok);
        splitter.release(inbox);
        vm.prank(dev);
        vault.accept(id);
        vm.prank(dev);
        assertEq(vault.claim(id), 5 ether);
    }

    // ------------------------------------------------------------- fuzz

    function testFuzz_expiryBoundary(uint256 window, uint256 elapsed) public {
        window = bound(window, 7 days, 365 days);
        elapsed = bound(elapsed, 0, 400 days);
        (uint256 id,) = _create(address(token), window, address(0));
        _fund(id, 1e18);
        vm.warp(block.timestamp + elapsed);
        if (elapsed < window) {
            vm.prank(dev);
            vault.accept(id);
            vm.prank(creator);
            vm.expectRevert();
            vault.reclaim(id);
        } else {
            vm.prank(dev);
            vm.expectRevert();
            vault.accept(id);
            vm.prank(creator);
            assertEq(vault.reclaim(id), 1e18);
        }
    }

    function testFuzz_conservationAndNoDoublePay(uint96 a, uint96 b, uint96 c, bool acceptIt) public {
        a = uint96(bound(a, 1, 1e27));
        (uint256 id, address inbox) = _create(address(token), 0, address(0));
        _fund(id, a);
        if (b > 0) token.transfer(inbox, b);
        uint256 total = uint256(a) + b;
        if (acceptIt) {
            vm.prank(dev);
            vault.accept(id);
            if (c > 0) token.transfer(inbox, c);
            vm.prank(dev);
            uint256 paid = vault.claim(id);
            assertEq(paid, total + c);
            assertEq(token.balanceOf(dev), total + c);
            vm.prank(dev);
            vm.expectRevert(PluggedFeeVault.NothingToPay.selector);
            vault.claim(id);
        } else {
            vm.prank(dev);
            vault.decline(id);
            vm.prank(creator);
            assertEq(vault.reclaim(id), total);
            assertEq(token.balanceOf(creator), total);
        }
        assertEq(vault.totalHeld(address(token)), 0);
        assertEq(vault.totalCredited(address(token)), vault.totalPaid(address(token)));
        assertEq(token.balanceOf(address(vault)), 0);
    }
}

// ---------------------------------------------------------------------- invariants

contract VaultHandler is Test {
    PluggedFeeVault public vault;
    VaultToken public token;
    address[3] public actors;
    uint256[] public ids;
    mapping(uint256 => bool) public everAccepted;
    mapping(uint256 => uint256) public allocatorReceivedAfterAccept;
    uint256 public paidOut;
    uint256 public pushedToInboxes;

    constructor(PluggedFeeVault vault_, VaultToken token_) {
        vault = vault_;
        token = token_;
        actors = [makeAddr("a0"), makeAddr("a1"), makeAddr("a2")];
    }

    function _id(uint256 seed) internal view returns (uint256) {
        return ids[seed % ids.length];
    }

    function create(uint256 a, uint256 r, uint256 window) external {
        a %= 3;
        address allocator = actors[a];
        address recipient = actors[(a + 1 + (r % 2)) % 3];
        window = bound(window, 7 days, 365 days);
        vm.prank(allocator);
        (uint256 id,) = vault.createContainer(recipient, address(token), window, actors[(a + 2) % 3], 0);
        ids.push(id);
    }

    function deposit(uint256 seed, uint256 amount) external {
        if (ids.length == 0) return;
        amount = bound(amount, 1, 1e24);
        token.mint(address(this), amount);
        token.approve(address(vault), amount);
        vault.deposit(_id(seed), amount);
    }

    function push(uint256 seed, uint256 amount) external {
        if (ids.length == 0) return;
        amount = bound(amount, 1, 1e24);
        token.mint(vault.getContainer(_id(seed)).inbox, amount);
        pushedToInboxes += amount;
    }

    function sweep(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 got = vault.sweepInbox(_id(seed));
        pushedToInboxes -= got;
    }

    function accept(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = _id(seed);
        vm.prank(vault.getContainer(id).recipient);
        try vault.accept(id) {
            everAccepted[id] = true;
        } catch {}
    }

    function decline(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = _id(seed);
        vm.prank(vault.getContainer(id).recipient);
        try vault.decline(id) {} catch {}
    }

    function claim(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = _id(seed);
        PluggedFeeVault.Container memory c = vault.getContainer(id);
        uint256 inboxBefore = token.balanceOf(c.inbox);
        vm.prank(c.recipient);
        try vault.claim(id) returns (uint256 amount) {
            paidOut += amount;
            pushedToInboxes -= inboxBefore;
        } catch {}
    }

    function reclaim(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = _id(seed);
        PluggedFeeVault.Container memory c = vault.getContainer(id);
        uint256 inboxBefore = token.balanceOf(c.inbox);
        vm.prank(c.allocator);
        try vault.reclaim(id) returns (uint256 amount) {
            paidOut += amount;
            pushedToInboxes -= inboxBefore;
            if (everAccepted[id]) allocatorReceivedAfterAccept[id] += amount;
        } catch {}
    }

    function operatorReturn(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = _id(seed);
        PluggedFeeVault.Container memory c = vault.getContainer(id);
        uint256 inboxBefore = token.balanceOf(c.inbox);
        vm.prank(c.operator);
        try vault.operatorReturn(id) returns (uint256 amount) {
            paidOut += amount;
            pushedToInboxes -= inboxBefore;
            if (everAccepted[id]) allocatorReceivedAfterAccept[id] += amount;
        } catch {}
    }

    function extend(uint256 seed, uint256 by) external {
        if (ids.length == 0) return;
        uint256 id = _id(seed);
        PluggedFeeVault.Container memory c = vault.getContainer(id);
        by = bound(by, 1, 30 days);
        vm.prank(c.operator);
        try vault.extendDeadline(id, uint40(uint256(c.deadline) + by)) {} catch {}
    }

    function warp(uint256 by) external {
        vm.warp(block.timestamp + bound(by, 1, 60 days));
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }
}

contract PluggedFeeVaultInvariant is Test {
    PluggedFeeVault vault;
    VaultToken token;
    VaultHandler handler;

    function setUp() public {
        vault = new PluggedFeeVault();
        token = new VaultToken();
        handler = new VaultHandler(vault, token);
        targetContract(address(handler));
    }

    function invariant_conservation() public view {
        uint256 sum;
        uint256 n = handler.idCount();
        for (uint256 i; i < n; ++i) {
            PluggedFeeVault.Container memory c = vault.getContainer(handler.ids(i));
            sum += c.balance;
            assertEq(c.credited, c.balance + c.paid);
        }
        assertEq(sum, vault.totalHeld(address(token)));
        assertEq(token.balanceOf(address(vault)), vault.totalHeld(address(token)));
        assertEq(vault.totalCredited(address(token)), vault.totalHeld(address(token)) + vault.totalPaid(address(token)));
        assertEq(vault.totalPaid(address(token)), handler.paidOut());
    }

    function invariant_noClawbackAfterAccept() public view {
        uint256 n = handler.idCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.ids(i);
            assertEq(handler.allocatorReceivedAfterAccept(id), 0);
            if (handler.everAccepted(id)) {
                assertEq(uint256(vault.status(id)), uint256(PluggedFeeVault.State.ACCEPTED));
            }
        }
    }
}
