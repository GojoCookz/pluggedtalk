// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PairRegistry} from "carbon/src/PairRegistry.sol";

/// @notice Exact Carbon registry, with a constructor owner distinct from its deployment sender.
contract DeploymentOwnershipTest is Test {
    PairRegistry registry;
    address constant OWNER = address(0xA11CE);
    address constant OTHER = address(0xB0B);
    address constant PAIR = address(0x1234);

    function setUp() public {
        registry = new PairRegistry(OWNER);
    }

    function testConstructorAssignsOwnerWithoutTransfer() public view {
        assertEq(registry.owner(), OWNER);
        assertEq(registry.pendingOwner(), address(0));
        assertFalse(registry.isApproved(PAIR));
    }

    function testDeployerCannotApprovePairs() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        registry.approvePairWithoutOracle(PAIR, 6);
        vm.prank(OWNER);
        registry.approvePairWithoutOracle(PAIR, 6);
        assertTrue(registry.isApproved(PAIR));
        assertEq(registry.pairConfig(PAIR).tokenDecimals, 6);
    }

    function testPendingOwnerCannotActBeforeAcceptance() public {
        vm.prank(OWNER);
        registry.transferOwnership(OTHER);
        vm.prank(OTHER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OTHER));
        registry.approvePairWithoutOracle(PAIR, 6);
        assertEq(registry.owner(), OWNER);
    }

    function testOwnershipCannotBeRenounced() public {
        vm.prank(OWNER);
        vm.expectRevert(PairRegistry.OwnershipCannotBeRenounced.selector);
        registry.renounceOwnership();
        assertEq(registry.owner(), OWNER);
    }

    function testPairApprovalDoesNotClearOwnerDenial() public {
        vm.startPrank(OWNER);
        registry.approvePairWithoutOracle(PAIR, 6);
        registry.denyPair(PAIR, true);
        registry.approvePairWithoutOracle(PAIR, 6);
        vm.stopPrank();
        assertTrue(registry.pairConfig(PAIR).approved);
        assertTrue(registry.isDenied(PAIR));
        assertFalse(registry.isApproved(PAIR));
    }

    function testFuzzOnlyOwnerCanApprove(address attacker) public {
        vm.assume(attacker != OWNER);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        registry.approvePairWithoutOracle(PAIR, 6);
    }
}
