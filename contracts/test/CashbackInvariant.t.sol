// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PluggedCashback} from "../src/PluggedCashback.sol";
import {QuoteToken} from "./PluggedFeeSplitter.t.sol";

contract CashbackHandler is Test {
    QuoteToken public quote;
    PluggedCashback public cashback;
    uint256 internal constant KEY = 0xCA55;
    mapping(address => uint256) public fees;

    constructor(QuoteToken q, PluggedCashback c) {
        quote = q;
        cashback = c;
        quote.approve(address(c), type(uint256).max);
    }

    function fund(uint96 raw) external {
        uint256 amount = bound(raw, 0, cashback.BUDGET() - cashback.totalFunded());
        if (amount == 0) return;
        quote.mint(address(this), amount);
        cashback.fund(amount);
    }

    function redeem(bool first, uint96 raw) external {
        address trader = first ? address(0xA11CE) : address(0xB0B);
        uint256 cumulative = fees[trader] + bound(raw, 0, 1e9);
        uint256 entitled = cumulative / 10;
        if (
            entitled <= cashback.claimed(trader)
                || entitled - cashback.claimed(trader) > cashback.totalFunded() - cashback.totalClaimed()
        ) return;
        fees[trader] = cumulative;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(KEY, cashback.voucherDigest(trader, cumulative, type(uint256).max, keccak256("trades")));
        cashback.claim(trader, cumulative, type(uint256).max, keccak256("trades"), abi.encodePacked(r, s, v));
    }
}

contract CashbackInvariantTest is StdInvariant, Test {
    QuoteToken quote;
    PluggedCashback cashback;
    CashbackHandler handler;

    function setUp() public {
        quote = new QuoteToken();
        cashback = new PluggedCashback(address(quote), vm.addr(0xCA55), 1000, 1e12);
        handler = new CashbackHandler(quote, cashback);
        targetContract(address(handler));
    }

    function invariant_BudgetConservationAndEntitlement() public view {
        uint256 paid = quote.balanceOf(address(0xA11CE)) + quote.balanceOf(address(0xB0B));
        assertEq(paid, cashback.totalClaimed());
        assertEq(paid + quote.balanceOf(address(cashback)), cashback.totalFunded());
        assertLe(cashback.totalFunded(), cashback.BUDGET());
        assertLe(quote.balanceOf(address(0xA11CE)), handler.fees(address(0xA11CE)) / 10);
        assertLe(quote.balanceOf(address(0xB0B)), handler.fees(address(0xB0B)) / 10);
    }
}
