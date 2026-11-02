// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @title PluggedFeeSplitter
/// @notice Immutable collaborator shares of one funded fee-recipient pool.
/// @dev Intended as Launcher.feeRecipient. This is NOT a trading tax or a holder dividend ledger.
///      No owner, upgrade, share edits, rescue, or identity-resolution privileges exist.
///      Use only a vetted, non-rebasing, non-taxed ERC-20, or address(0) for native ETH.
///      Claim math follows cumulative receipts, so frequent claims cannot consume others' dust.
///      Funds sent directly by a hook are automatically accounted without a deposit callback.
contract PluggedFeeSplitter is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_RECIPIENTS = 100;

    // Match the existing Hood contract getter naming used by integrations.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable currency;
    /// @notice Off-chain plan commitment only. It does not prove GitHub identity or ownership.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    bytes32 public immutable planHash;
    address[] public recipients;
    mapping(address => uint256) public sharesBps;
    mapping(address => uint256) public released;
    uint256 public totalReleased;

    error InvalidRecipients();
    error InvalidRecipient(address recipient);
    error DuplicateRecipient(address recipient);
    error InvalidShares();
    error InvalidCurrency();
    error NothingToClaim();
    error NativePaymentFailed();
    error UnsupportedTokenBehavior();

    event SplitConfigured(
        address indexed currency, bytes32 indexed planHash, address[] recipients, uint16[] bps
    );
    event NativeReceived(address indexed sender, uint256 amount);
    event Released(address indexed recipient, address indexed currency, uint256 amount);

    constructor(address currency_, address[] memory recipients_, uint16[] memory bps_, bytes32 planHash_) {
        uint256 count = recipients_.length;
        if (count == 0 || count > MAX_RECIPIENTS || count != bps_.length) revert InvalidRecipients();
        if (currency_ != address(0) && currency_.code.length == 0) revert InvalidCurrency();
        currency = currency_;
        planHash = planHash_;
        uint256 sum;
        for (uint256 i; i < count; ++i) {
            address recipient = recipients_[i];
            if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient(recipient);
            if (sharesBps[recipient] != 0) revert DuplicateRecipient(recipient);
            if (bps_[i] == 0) revert InvalidShares();
            sharesBps[recipient] = bps_[i];
            sum += bps_[i];
            recipients.push(recipient);
        }
        if (sum != BPS) revert InvalidShares();
        emit SplitConfigured(currency_, planHash_, recipients_, bps_);
    }

    receive() external payable {
        if (currency != address(0)) revert InvalidCurrency();
        emit NativeReceived(msg.sender, msg.value);
    }

    function recipientCount() external view returns (uint256) {
        return recipients.length;
    }

    function totalReceived() external view nonReentrantView returns (uint256) {
        return _balance() + totalReleased;
    }

    function claimable(address recipient) external view nonReentrantView returns (uint256) {
        return _claimable(recipient);
    }

    /// @notice Anyone may pay gas, but funds always go to the immutable recipient.
    /// @dev One receiver failing does not block any other recipient's separate claim.
    function release(address recipient) external nonReentrant returns (uint256 amount) {
        amount = _claimable(recipient);
        if (amount == 0) revert NothingToClaim();
        released[recipient] += amount;
        totalReleased += amount;
        if (currency == address(0)) {
            (bool success,) = payable(recipient).call{value: amount}("");
            if (!success) revert NativePaymentFailed();
        } else {
            IERC20 token = IERC20(currency);
            uint256 beforeBalance = token.balanceOf(address(this));
            uint256 beforeRecipient = token.balanceOf(recipient);
            token.safeTransfer(recipient, amount);
            // Reject transfer taxes / sender surcharges rather than reporting an unpaid claim as paid.
            if (
                token.balanceOf(address(this)) != beforeBalance - amount
                    || token.balanceOf(recipient) != beforeRecipient + amount
            ) revert UnsupportedTokenBehavior();
        }
        emit Released(recipient, currency, amount);
    }

    function _claimable(address recipient) private view returns (uint256) {
        return Math.mulDiv(_balance() + totalReleased, sharesBps[recipient], BPS) - released[recipient];
    }

    function _balance() private view returns (uint256) {
        return currency == address(0) ? address(this).balance : IERC20(currency).balanceOf(address(this));
    }
}
