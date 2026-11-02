// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AdvancedHarness} from "./AdvancedFactory.t.sol";
import {PluggedAdvancedFactory} from "../src/PluggedAdvancedFactory.sol";
import {PluggedAdvancedToken} from "../src/PluggedAdvancedToken.sol";
import {PluggedFeeSplitter} from "../src/PluggedFeeSplitter.sol";
import {PairRegistry} from "carbon/src/PairRegistry.sol";
import {BasketLedger} from "carbon/src/multi/BasketLedger.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

/// @notice Pinned local fork only. Real Robinhood PoolManager and canonical 6/8/18-decimal quotes.
/// @dev Deploys a NEW advanced stack on the fork; makes no claim that Carbon's live launcher changes.
contract AdvancedForkTest is AdvancedHarness {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    uint256 internal constant FORK_BLOCK = 102_855_166;
    bool internal enabled;

    function setUp() public override {
        enabled = vm.envOr("PLUGGED_ADVANCED_FORK", false);
        if (!enabled) return;
        vm.createSelectFork(
            vm.envOr("PLUGGED_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")),
            vm.envOr("PLUGGED_ADVANCED_FORK_BLOCK", FORK_BLOCK)
        );
        assertEq(block.chainid, 4663);
        manager = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
        assertGt(address(manager).code.length, 0);
        // A fresh local allowlist avoids mutating existing production-owned contracts, even in
        // simulation. No oracle-equality proof is claimed for these explicitly unpriced entries.
        pairs = new PairRegistry(address(this));
        quotes.push(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168); // USDG
        quotes.push(0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4); // cbBTC
        quotes.push(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73); // WETH
        quotes.push(0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9); // AAPL
        decimals.push(6);
        decimals.push(8);
        decimals.push(18);
        decimals.push(18);
        for (uint256 i; i < quotes.length; ++i) {
            assertGt(quotes[i].code.length, 0);
            pairs.approvePairWithoutOracle(quotes[i], decimals[i]);
        }
        _deployStack();
        _fundAndApprove();
    }

    function testForkAdvancedFourMarketsBothOrderingsFeesAndStrictCap() public {
        if (!enabled) vm.skip(true);
        for (uint256 direction; direction < 2; ++direction) {
            PluggedAdvancedFactory.LaunchParams memory p = _params(4);
            p.salt = _saltFor(direction == 0, 4);
            p.name = direction == 0 ? "Advanced Fork Zero" : "Advanced Fork One";
            vm.prank(CREATOR);
            (address deployed, uint8 priceable) = factory.launch(p);
            assertEq(priceable, 0, "no off-chain valuation presented as oracle proof");
            PluggedAdvancedToken token = PluggedAdvancedToken(deployed);
            assertGt(token.balanceOf(CREATOR), 0);
            assertLe(token.balanceOf(CREATOR), SUPPLY * 300 / 10_000);
            assertFalse(token.exemptFromMaxWallet(CREATOR));
            for (uint256 i; i < 4; ++i) {
                assertEq(deployed < quotes[i], direction == 0);
                PoolKey memory key = _key(deployed, quotes[i]);
                assertGt(manager.getLiquidity(key.toId()), 0);
                uint256 bought = _buy(token, i, 2 * 10 ** decimals[i]);
                assertGt(bought, 0);
                vm.startPrank(ALICE);
                token.approve(address(router), bought);
                uint256 sold = router.swap(key, deployed < quotes[i], bought, 1, ALICE);
                vm.stopPrank();
                assertGt(sold, 0);
                assertGt(hook.pendingFees(key.toId()), 0);
                hook.sweep(key);
                PluggedFeeSplitter splitter =
                    PluggedFeeSplitter(payable(factory.splitterOf(deployed, quotes[i])));
                uint256 owed = splitter.claimable(BOB);
                assertGt(owed, 0);
                uint256 before = IERC20(quotes[i]).balanceOf(BOB);
                splitter.release(BOB);
                assertEq(IERC20(quotes[i]).balanceOf(BOB) - before, owed);
                assertGt(IERC20(quotes[i]).balanceOf(address(token.ledger())), 0);
                assertEq(IERC20(quotes[i]).balanceOf(address(factory)), 0);
            }
            assertEq(token.balanceOf(address(factory)), 0);
            BasketLedger ledger = token.ledger();
            skip(25 hours);
            for (uint256 i; i < 4; ++i) {
                assertGt(ledger.withdrawableOf(CREATOR, quotes[i]), 0);
                vm.prank(CREATOR);
                ledger.withdrawOne(quotes[i]);
            }
        }
    }
}
