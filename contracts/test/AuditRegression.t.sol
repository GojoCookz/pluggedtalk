// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PluggedFeeVault} from "../src/PluggedFeeVault.sol";
import {PluggedFeeSplitter} from "../src/PluggedFeeSplitter.sol";
import {PluggedCampaign} from "../src/PluggedCampaign.sol";
import {PluggedAdvancedFactory} from "../src/PluggedAdvancedFactory.sol";
import {AdvancedHarness} from "./AdvancedFactory.t.sol";

contract RegressionToken is ERC20 {
    constructor() ERC20("T", "T") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// Audit 2026-11-02 M-1: the precomputed inbox used to be keyed by the global container id, so
/// whoever created that id first captured it. The inbox is now keyed by (caller, recipient, currency, salt).
contract VaultInboxRegression is Test {
    PluggedFeeVault vault;
    RegressionToken token;
    address creator = makeAddr("creator");
    address dev = makeAddr("dev");
    address attacker = makeAddr("attacker");
    address attackerWallet = makeAddr("attackerWallet");
    bytes32 constant SALT = keccak256("creator-launch-1");

    function setUp() public {
        vault = new PluggedFeeVault();
        token = new RegressionToken();
    }

    function test_predictedInboxCannotBeCapturedByAnotherCreator() public {
        address predicted = vault.predictInbox(creator, dev, address(token), SALT);
        address[] memory r = new address[](2);
        r[0] = predicted;
        r[1] = creator;
        uint16[] memory s = new uint16[](2);
        s[0] = 5000;
        s[1] = 5000;
        PluggedFeeSplitter splitter = new PluggedFeeSplitter(address(token), r, s, bytes32(0));

        // Attacker front-runs with the same recipient, currency and salt: different inbox.
        vm.prank(attacker);
        (uint256 attackerId, address attackerInbox) =
            vault.createContainer(attackerWallet, address(token), 0, address(0), bytes32(0), SALT);
        assertTrue(attackerInbox != predicted);
        vm.prank(attacker);
        (, address attackerInbox2) = vault.createContainer(dev, address(token), 0, address(0), bytes32(0), SALT);
        assertTrue(attackerInbox2 != predicted);

        // The creator still gets exactly the predicted inbox, whatever id it lands on.
        vm.prank(creator);
        (uint256 id, address inbox) = vault.createContainer(dev, address(token), 0, address(0), bytes32(0), SALT);
        assertEq(inbox, predicted);
        assertTrue(id != attackerId);

        token.mint(address(splitter), 1000 ether);
        splitter.release(predicted);
        vault.sweepInbox(id);
        vm.startPrank(dev);
        vault.accept(id);
        vault.claim(id);
        vm.stopPrank();
        assertEq(token.balanceOf(dev), 500 ether, "dev receives its 50%");
        assertEq(token.balanceOf(attackerWallet), 0);
    }

    function test_sameCallerSameSaltCannotRedeploy() public {
        vm.prank(creator);
        vault.createContainer(dev, address(token), 0, address(0), bytes32(0), SALT);
        vm.prank(creator);
        vm.expectRevert();
        vault.createContainer(dev, address(token), 0, address(0), bytes32(0), SALT);
    }
}

/// Audit L-4: a successful campaign whose payout cannot be delivered refunds after the grace period.
contract RejectsEth {
    receive() external payable {
        revert("no");
    }
}

contract CampaignRefundFallback is Test {
    function test_unpaidSuccessfulCampaignRefundsAfterGrace() public {
        RejectsEth bad = new RejectsEth();
        PluggedCampaign c = new PluggedCampaign(address(0), address(bad), 1 ether, block.timestamp + 1 days);
        address alice = makeAddr("alice");
        vm.deal(alice, 2 ether);
        vm.prank(alice);
        c.contribute{value: 1 ether}(1 ether);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert();
        c.payout(); // beneficiary rejects ETH
        vm.expectRevert(PluggedCampaign.WrongPhase.selector);
        c.refund(alice); // still inside grace
        vm.warp(block.timestamp + c.PAYOUT_GRACE());
        vm.expectRevert(PluggedCampaign.WrongPhase.selector);
        c.payout(); // payout window closed
        c.refund(alice);
        assertEq(alice.balance, 2 ether);
    }
}

/// Audit L-2: record the worst-case advanced launch gas with the lowered recipient cap.
contract AdvancedGasRegression is AdvancedHarness {
    function test_gas_maxLaunch_4markets_maxRecipients() public {
        PluggedAdvancedFactory.LaunchParams memory p = _params(4);
        uint256 n = factory.MAX_RECIPIENTS();
        p.recipients = new address[](n);
        p.sharesBps = new uint16[](n);
        for (uint256 i; i < n; ++i) {
            p.recipients[i] = address(uint160(0x100000 + i));
            p.sharesBps[i] = uint16(10000 / n);
        }
        for (uint256 i; i < 4; ++i) p.markets[i].creatorBps = 5000;
        uint256 g = gasleft();
        _launch(p);
        uint256 used = g - gasleft();
        console.log("launch gas (4 markets x MAX_RECIPIENTS):", used);
        assertLt(used, 20_000_000, "max launch stays well under the ~32M Nitro block gas limit");
    }

    function test_recipientCapEnforced() public {
        PluggedAdvancedFactory.LaunchParams memory p = _params(1);
        uint256 n = factory.MAX_RECIPIENTS() + 1;
        p.recipients = new address[](n);
        p.sharesBps = new uint16[](n);
        for (uint256 i; i < n; ++i) {
            p.recipients[i] = address(uint160(0x100000 + i));
            p.sharesBps[i] = 1;
        }
        p.sharesBps[0] = uint16(10000 - (n - 1));
        vm.prank(CREATOR);
        vm.expectRevert(PluggedAdvancedFactory.InvalidRecipients.selector);
        factory.launch(p);
    }
}
