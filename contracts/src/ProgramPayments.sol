// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @dev Standard, non-rebasing ERC-20 or native ETH only. No custody of unrelated assets.
abstract contract ProgramPayments is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    address public immutable CURRENCY;
    error InvalidPayment();
    error UnsupportedToken();
    error PaymentFailed();

    constructor(address currency) {
        if (currency != address(0) && currency.code.length == 0) revert UnsupportedToken();
        CURRENCY = currency;
    }

    function _collect(uint256 amount) internal {
        if (amount == 0) revert InvalidPayment();
        if (CURRENCY == address(0)) {
            if (msg.value != amount) revert InvalidPayment();
        } else {
            if (msg.value != 0) revert InvalidPayment();
            IERC20 token = IERC20(CURRENCY);
            uint256 beforeBalance = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), amount);
            if (token.balanceOf(address(this)) != beforeBalance + amount) revert UnsupportedToken();
        }
    }

    function _pay(address recipient, uint256 amount) internal {
        if (CURRENCY == address(0)) {
            (bool ok,) = payable(recipient).call{value: amount}("");
            if (!ok) revert PaymentFailed();
        } else {
            IERC20 token = IERC20(CURRENCY);
            uint256 beforeBalance = token.balanceOf(address(this));
            uint256 beforeRecipient = token.balanceOf(recipient);
            token.safeTransfer(recipient, amount);
            if (
                token.balanceOf(address(this)) != beforeBalance - amount
                    || token.balanceOf(recipient) != beforeRecipient + amount
            ) revert UnsupportedToken();
        }
    }
}
