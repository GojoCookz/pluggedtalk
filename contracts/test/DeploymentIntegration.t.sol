// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AdvancedHarness} from "./AdvancedFactory.t.sol";
import {PluggedAdvancedFactory} from "../src/PluggedAdvancedFactory.sol";
import {PluggedLaunchRegistry} from "../src/PluggedLaunchRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Two funded callers racing the same economic identity, tested in both orderings.
contract DeploymentIntegrationTest is AdvancedHarness {
    function testThreeMarketsRequireAndSupportDivisibleRawSupply() public {
        PluggedAdvancedFactory.LaunchParams memory p = _params(3);
        vm.expectRevert(PluggedAdvancedFactory.InvalidEconomics.selector);
        factory.economicsHash(p);
        p.supply -= 1; // 10^27 - 1 is divisible by three; no silently stranded supply remainder.
        address token = address(_launch(p));
        assertEq(IERC20(token).totalSupply(), p.supply);
        assertEq(factory.poolsOf(token).length, 3);
        assertEq(IERC20(token).balanceOf(address(factory)), 0);
    }

    function testFirstSuccessfulCallerWinsWithoutChargingOrReservingLoser() public {
        PluggedAdvancedFactory.LaunchParams memory p = _params(1);
        vm.prank(ALICE);
        IERC20(quotes[0]).approve(address(factory), type(uint256).max);
        uint256 snapshot = vm.snapshotState();
        _race(p, CREATOR, ALICE);
        assertTrue(vm.revertToState(snapshot));
        _race(p, ALICE, CREATOR);
    }

    function _race(PluggedAdvancedFactory.LaunchParams memory p, address winner, address loser) private {
        bytes32 economics = factory.economicsHash(p);
        bytes32 key = factory.registry().fingerprint(p.symbol, p.name, economics);
        address predictedLoser = factory.predictTokenAddressFor(loser, p.salt);
        uint256 balanceBefore = IERC20(quotes[0]).balanceOf(loser);
        assertGe(balanceBefore, p.markets[0].devBuyPairAmount);
        assertGe(IERC20(quotes[0]).allowance(loser, address(factory)), p.markets[0].devBuyPairAmount);
        vm.prank(winner);
        (address token,) = factory.launch(p);
        assertTrue(token != predictedLoser);
        vm.prank(loser);
        vm.expectRevert(abi.encodeWithSelector(PluggedLaunchRegistry.DuplicateLaunch.selector, key, token));
        factory.launch(p);
        assertEq(IERC20(quotes[0]).balanceOf(loser), balanceBefore);
        assertEq(predictedLoser.code.length, 0);
        assertEq(factory.registry().tokenFor(key), token);
        assertEq(factory.launchCount(), 1);
    }
}
