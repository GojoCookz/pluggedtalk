// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeHook} from "carbon/src/FeeHook.sol";
import {PluggedFeeSplitter} from "./PluggedFeeSplitter.sol";

/// @notice Immutable PluggedFeeSplitter plus permissionless recovery from one fixed Carbon hook.
/// @dev Inherits the original cumulative-receipts accounting and the same reentrancy guard as
///      release(). Recovery cannot redirect funds or change shares; recovered funds simply become
///      funded splitter receipts. No existing splitter contract is modified.
contract PluggedAdvancedSplitter is PluggedFeeSplitter {
    address public immutable hook;

    error InvalidHook();
    event StuckFeesRecovered(uint256 amount);

    constructor(
        address currency_,
        address[] memory recipients_,
        uint16[] memory bps_,
        bytes32 planHash_,
        address hook_
    ) PluggedFeeSplitter(currency_, recipients_, bps_, planHash_) {
        if (currency_ == address(0) || hook_.code.length == 0) revert InvalidHook();
        hook = hook_;
    }

    /// @notice Anyone may trigger recovery; the unchanged release() pays only fixed recipients.
    function recoverStuckFees() external nonReentrant returns (uint256 amount) {
        IERC20 token = IERC20(currency);
        uint256 beforeBalance = token.balanceOf(address(this));
        // Carbon's CEI clears the liability first; any failed funding check rolls back the claim.
        amount = FeeHook(hook).claimStuckFees(currency);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedTokenBehavior();
        emit StuckFeesRecovered(amount);
    }
}
