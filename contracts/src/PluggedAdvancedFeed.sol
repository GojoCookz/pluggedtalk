// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {BasketLedger} from "carbon/src/multi/BasketLedger.sol";
import {FeeHook} from "carbon/src/FeeHook.sol";

/// @notice Carbon MarketFeed-compatible adapter with fixed-hook deferred-payout recovery.
/// @dev No caller-selected currency, hook or recipient. A recovery failure reverts Carbon's
///      claim bookkeeping too, preserving the entire deferred liability. All forwarding paths
///      share one transient reentrancy guard and only credit verified ledger funding.
contract PluggedAdvancedFeed is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    BasketLedger public immutable ledger;
    address public immutable currency;
    address public immutable hook;

    error OnlyHook();
    error InvalidWiring();
    error UnsupportedTokenBehavior();
    event StuckFeesRecovered(uint256 amount);

    constructor(BasketLedger ledger_, address currency_, address hook_) {
        if (address(ledger_).code.length == 0 || currency_.code.length == 0 || hook_.code.length == 0) {
            revert InvalidWiring();
        }
        ledger = ledger_;
        currency = currency_;
        hook = hook_;
    }

    /// @notice Exact distributor selector expected by Carbon FeeHook; measured balance is forwarded.
    function distribute(uint256) external nonReentrant {
        if (msg.sender != hook) revert OnlyHook();
        _forward();
    }

    /// @notice Forward any previously received funds or a direct donation to the fixed ledger.
    function sync() external nonReentrant {
        _forward();
    }

    /// @notice Anyone may trigger recovery; all proceeds go to this feed's immutable holder ledger.
    function recoverStuckFees() external nonReentrant returns (uint256 amount) {
        IERC20 token = IERC20(currency);
        uint256 beforeBalance = token.balanceOf(address(this));
        // Carbon zeroes its liability before transferring. A later revert here restores it.
        amount = FeeHook(hook).claimStuckFees(currency);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedTokenBehavior();
        _forward();
        emit StuckFeesRecovered(amount);
    }

    function _forward() private {
        IERC20 token = IERC20(currency);
        uint256 amount = token.balanceOf(address(this));
        if (amount == 0) return;
        uint256 beforeBalance = token.balanceOf(address(ledger));
        token.safeTransfer(address(ledger), amount);
        if (token.balanceOf(address(ledger)) - beforeBalance != amount) revert UnsupportedTokenBehavior();
        ledger.credit(currency, amount);
    }
}
