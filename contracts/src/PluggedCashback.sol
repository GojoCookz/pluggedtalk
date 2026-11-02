// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {ProgramPayments} from "./ProgramPayments.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Separately funded, capped cashback on cumulative eligible paid fees, never volume.
/// @dev The immutable attestor authenticates trades off-chain. An attestor can allocate the
///      entire funded budget; this is NOT trustless trade verification. No attestor service
///      or router integration is included. Unclaimed funding has no admin withdrawal path.
contract PluggedCashback is ProgramPayments, EIP712 {
    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("FeeVoucher(address trader,uint256 cumulativeFees,uint256 validUntil,bytes32 evidence)");
    address public immutable ATTESTOR;
    uint256 public immutable REBATE_BPS;
    uint256 public immutable BUDGET;
    uint256 public totalFunded;
    uint256 public totalClaimed;
    mapping(address => uint256) public claimed;
    error InvalidProgram();
    error InvalidVoucher();
    error BudgetExceeded();
    error NothingToClaim();
    event Funded(address indexed funder, uint256 amount);
    event Claimed(address indexed trader, uint256 amount, uint256 cumulativeFees, bytes32 evidence);

    constructor(address currency, address attestor, uint256 rebateBps, uint256 budget)
        ProgramPayments(currency)
        EIP712("PluggedCashback", "1")
    {
        if (attestor == address(0) || rebateBps == 0 || rebateBps > 10000 || budget == 0) {
            revert InvalidProgram();
        }
        ATTESTOR = attestor;
        REBATE_BPS = rebateBps;
        BUDGET = budget;
    }

    function fund(uint256 amount) external payable nonReentrant {
        if (amount > BUDGET - totalFunded) revert BudgetExceeded();
        _collect(amount);
        totalFunded += amount;
        emit Funded(msg.sender, amount);
    }

    function voucherDigest(address trader, uint256 cumulativeFees, uint256 validUntil, bytes32 evidence)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(VOUCHER_TYPEHASH, trader, cumulativeFees, validUntil, evidence))
        );
    }

    function claim(
        address trader,
        uint256 cumulativeFees,
        uint256 validUntil,
        bytes32 evidence,
        bytes calldata signature
    ) external nonReentrant {
        if (
            trader == address(0) || trader == address(this) || block.timestamp > validUntil
                || ECDSA.recover(voucherDigest(trader, cumulativeFees, validUntil, evidence), signature)
                    != ATTESTOR
        ) revert InvalidVoucher();
        uint256 entitlement = Math.mulDiv(cumulativeFees, REBATE_BPS, 10000);
        if (entitlement <= claimed[trader]) revert NothingToClaim();
        uint256 amount = entitlement - claimed[trader];
        if (amount > totalFunded - totalClaimed) revert BudgetExceeded();
        claimed[trader] = entitlement;
        totalClaimed += amount;
        _pay(trader, amount);
        emit Claimed(trader, amount, cumulativeFees, evidence);
    }
}
