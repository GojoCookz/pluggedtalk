// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {ProgramPayments} from "./ProgramPayments.sol";

/// @notice Fixed-beneficiary all-or-nothing funding, with permissionless fixed-address refunds.
/// @dev No admin, cancellation, early payout, arbitrary treasury or cashback access to escrow.
///      Only recorded contributions count toward the target; direct transfers do not force success.
contract PluggedCampaign is ProgramPayments {
    address public immutable BENEFICIARY;
    uint256 public immutable GOAL;
    uint256 public immutable DEADLINE;
    uint256 public totalContributed;
    uint256 public totalRefunded;
    bool public paid;
    mapping(address => uint256) public contributions;
    error InvalidCampaign();
    error WrongPhase();
    error NothingToRefund();
    event Contributed(address indexed contributor, uint256 amount);
    event Refunded(address indexed contributor, uint256 amount);
    event Paid(address indexed beneficiary, uint256 amount);

    constructor(address currency, address beneficiary, uint256 goal, uint256 deadline)
        ProgramPayments(currency)
    {
        if (
            beneficiary == address(0) || beneficiary == address(this) || goal == 0
                || deadline <= block.timestamp
        ) revert InvalidCampaign();
        BENEFICIARY = beneficiary;
        GOAL = goal;
        DEADLINE = deadline;
    }

    function contribute(uint256 amount) external payable nonReentrant {
        if (block.timestamp >= DEADLINE) revert WrongPhase();
        _collect(amount);
        contributions[msg.sender] += amount;
        totalContributed += amount;
        emit Contributed(msg.sender, amount);
    }

    function payout() external nonReentrant {
        if (block.timestamp < DEADLINE || totalContributed < GOAL || paid) revert WrongPhase();
        paid = true;
        _pay(BENEFICIARY, totalContributed);
        emit Paid(BENEFICIARY, totalContributed);
    }

    function refund(address contributor) external nonReentrant {
        if (block.timestamp < DEADLINE || totalContributed >= GOAL) revert WrongPhase();
        uint256 amount = contributions[contributor];
        if (amount == 0) revert NothingToRefund();
        contributions[contributor] = 0;
        totalRefunded += amount;
        _pay(contributor, amount);
        emit Refunded(contributor, amount);
    }
}
