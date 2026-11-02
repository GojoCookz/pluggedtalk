// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {AdvancedHarness} from "./AdvancedFactory.t.sol";
import {PluggedAdvancedFactory} from "../src/PluggedAdvancedFactory.sol";
import {PluggedAdvancedToken} from "../src/PluggedAdvancedToken.sol";
import {PluggedFeeSplitter} from "../src/PluggedFeeSplitter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeHook} from "carbon/src/FeeHook.sol";
import {TradeRouter} from "carbon/src/TradeRouter.sol";
import {BasketLedger} from "carbon/src/multi/BasketLedger.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

/// @notice Stateful trading, transfers, fee sweeps and streamed claims over actual v4 pools.
contract AdvancedHandler is Test {
    PluggedAdvancedToken public token;
    PluggedAdvancedFactory public factory;
    TradeRouter public router;
    FeeHook public hook;
    address[4] public actors = [address(0xCAFE), address(0xA11CE), address(0xB0B), address(0xD00D)];
    address[2] public quotes;
    uint256[2] public units;
    uint256 public successfulBuys;
    uint256 public successfulSells;
    uint256 public successfulTransfers;
    uint256 public successfulSweeps;
    uint256 public successfulClaims;

    constructor(PluggedAdvancedToken t, PluggedAdvancedFactory f, TradeRouter r, address[2] memory q) {
        token = t;
        factory = f;
        router = r;
        hook = f.feeHook();
        quotes = q;
        units = [uint256(1e6), uint256(1e8)];
        for (uint256 a; a < actors.length; ++a) {
            vm.startPrank(actors[a]);
            t.approve(address(r), type(uint256).max);
            vm.stopPrank();
            for (uint256 i; i < 2; ++i) {
                deal(q[i], actors[a], 1_000_000 * units[i]);
                vm.prank(actors[a]);
                IERC20(q[i]).approve(address(r), type(uint256).max);
            }
        }
    }

    function _key(uint256 i) private view returns (PoolKey memory) {
        bool first = address(token) < quotes[i];
        return PoolKey(
            Currency.wrap(first ? address(token) : quotes[i]),
            Currency.wrap(first ? quotes[i] : address(token)),
            0,
            60,
            IHooks(address(hook))
        );
    }

    function buy(uint256 who, uint256 market, uint256 rawAmount) external {
        uint256 i = market % 2;
        uint256 amount = bound(rawAmount, units[i] / 100, 25 * units[i]);
        vm.prank(actors[who % 4]);
        try router.swap(_key(i), address(token) > quotes[i], amount, 1, actors[who % 4]) returns (uint256) {
            ++successfulBuys;
        } catch {}
    }

    function sell(uint256 who, uint256 market, uint256 rawAmount) external {
        address actor = actors[who % 4];
        uint256 balance = token.balanceOf(actor);
        if (balance == 0) return;
        uint256 i = market % 2;
        uint256 amount = bound(rawAmount, 1, balance);
        vm.prank(actor);
        try router.swap(_key(i), address(token) < quotes[i], amount, 0, actor) returns (uint256) {
            ++successfulSells;
        } catch {}
    }

    function move(uint256 from, uint256 to, uint256 rawAmount) external {
        address actor = actors[from % 4];
        uint256 balance = token.balanceOf(actor);
        if (balance == 0) return;
        uint256 amount = bound(rawAmount, 0, balance);
        vm.prank(actor);
        try token.transfer(actors[to % 4], amount) returns (bool) {
            ++successfulTransfers;
        } catch {}
    }

    function sweep(uint256 market) external {
        try hook.sweep(_key(market % 2)) {
            ++successfulSweeps;
        } catch {}
    }

    function claim(uint256 who, uint256 market, uint32 secondsForward) external {
        skip(bound(secondsForward, 1, 2 days));
        uint256 i = market % 2;
        address actor = actors[who % 4];
        BasketLedger ledger = token.ledger();
        vm.prank(actor);
        try ledger.withdrawOne(quotes[i]) returns (uint256) {
            ++successfulClaims;
        } catch {}
        PluggedFeeSplitter splitter =
            PluggedFeeSplitter(payable(factory.splitterOf(address(token), quotes[i])));
        try splitter.release(actor) returns (uint256) {
            ++successfulClaims;
        } catch {}
    }
}

contract AdvancedInvariantTest is AdvancedHarness {
    PluggedAdvancedToken internal token;
    AdvancedHandler internal handler;

    function setUp() public override {
        super.setUp();
        token = _launch(_params(2));
        handler = new AdvancedHandler(token, factory, router, [quotes[0], quotes[1]]);
        handler.buy(1, 0, 1e6);
        handler.sell(1, 0, 100 ether);
        handler.move(0, 2, 100 ether);
        handler.sweep(0);
        handler.claim(0, 0, 1 days);
        assertGt(handler.successfulBuys(), 0);
        assertGt(handler.successfulSells(), 0);
        assertGt(handler.successfulTransfers(), 0);
        assertGt(handler.successfulSweeps(), 0);
        assertGt(handler.successfulClaims(), 0);
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = AdvancedHandler.buy.selector;
        selectors[1] = AdvancedHandler.sell.selector;
        selectors[2] = AdvancedHandler.move.selector;
        selectors[3] = AdvancedHandler.sweep.selector;
        selectors[4] = AdvancedHandler.claim.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariantEveryOrdinaryWalletCappedAndSupplyConserved() public view {
        uint256 held;
        for (uint256 i; i < 4; ++i) {
            address actor = handler.actors(i);
            uint256 balance = token.balanceOf(actor);
            assertFalse(token.exemptFromMaxWallet(actor));
            assertLe(balance, token.maxWallet());
            held += balance;
        }
        held += token.balanceOf(address(manager)) + token.balanceOf(address(hook))
        + token.balanceOf(address(0xdEaD)) + token.balanceOf(address(token.ledger()));
        assertEq(held, token.totalSupply());
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(address(factory)), 0);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function invariantIndependentSplittersAndHolderLedgersSolvent() public view {
        BasketLedger ledger = token.ledger();
        for (uint256 i; i < 2; ++i) {
            address quote = quotes[i];
            PluggedFeeSplitter splitter =
                PluggedFeeSplitter(payable(factory.splitterOf(address(token), quote)));
            assertEq(splitter.currency(), quote);
            assertLe(
                splitter.claimable(ALICE) + splitter.claimable(BOB),
                IERC20(quote).balanceOf(address(splitter))
            );
            assertEq(
                splitter.totalReleased() + IERC20(quote).balanceOf(address(splitter)),
                splitter.totalReceived()
            );
            uint256 owed;
            for (uint256 a; a < 4; ++a) {
                owed += ledger.withdrawableOf(handler.actors(a), quote);
            }
            assertLe(
                owed, IERC20(quote).balanceOf(address(ledger)), "Carbon holder liabilities exceed funding"
            );
            assertLe(
                ledger.totalWithdrawnOf(quote),
                ledger.totalDistributedOf(quote),
                "Carbon withdrawals exceed vested funding"
            );
            assertEq(IERC20(quote).balanceOf(address(factory)), 0);
        }
    }
}
