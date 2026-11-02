// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {FeeHook} from "carbon/src/FeeHook.sol";
import {PairRegistry} from "carbon/src/PairRegistry.sol";
import {TradeRouter} from "carbon/src/TradeRouter.sol";
import {BasketLedger} from "carbon/src/multi/BasketLedger.sol";
import {MultiDeployer} from "carbon/src/multi/MultiDeployer.sol";
import {MultiVestingVault} from "carbon/src/multi/MultiVestingVault.sol";
import {LaunchMetadata} from "carbon/src/types/LaunchMetadata.sol";
import {MockERC20} from "carbon/test/mocks/MockERC20.sol";
import {MockAggregatorV3} from "carbon/test/mocks/MockAggregatorV3.sol";
import {PluggedAdvancedFactory} from "../src/PluggedAdvancedFactory.sol";
import {PluggedAdvancedToken} from "../src/PluggedAdvancedToken.sol";
import {PluggedLaunchRegistry} from "../src/PluggedLaunchRegistry.sol";
import {PluggedFeeSplitter} from "../src/PluggedFeeSplitter.sol";

abstract contract AdvancedHarness is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    uint256 internal constant SUPPLY = 1_000_000_000 ether;
    address internal constant CREATOR = address(0xCAFE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant PLATFORM = address(0xFEE);
    IPoolManager internal manager;
    PairRegistry internal pairs;
    PluggedAdvancedFactory internal factory;
    PluggedAdvancedToken internal implementation;
    FeeHook internal hook;
    TradeRouter internal router;
    PoolSwapTest internal exactRouter;
    address[] internal quotes;
    uint8[] internal decimals;

    function setUp() public virtual {
        manager = IPoolManager(address(new PoolManager(address(this))));
        pairs = new PairRegistry(address(this));
        for (uint256 i; i < 4; ++i) {
            uint8 dec = i == 0 ? 6 : i == 1 ? 8 : 18;
            MockERC20 quote = new MockERC20("Quote", "Q", dec);
            MockAggregatorV3 feed = new MockAggregatorV3(8, 1e8, "Quote/USD");
            pairs.approvePair(address(quote), address(feed), 1 days, dec);
            quotes.push(address(quote));
            decimals.push(dec);
        }
        _deployStack();
        _fundAndApprove();
    }

    function _deployStack() internal {
        implementation = new PluggedAdvancedToken();
        MultiDeployer satellites = new MultiDeployer();
        router = new TradeRouter(manager);
        exactRouter = new PoolSwapTest(manager);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        address hookAddress = address(uint160(uint256(0xABCD) << 144 | 0x20CC));
        deployCodeTo("FeeHook.sol:FeeHook", abi.encode(manager, predicted, PLATFORM), hookAddress);
        hook = FeeHook(hookAddress);
        factory = new PluggedAdvancedFactory(manager, hook, pairs, address(implementation), satellites);
        assertEq(address(factory), predicted);
        assertEq(factory.registry().FACTORY(), predicted);
    }

    function _fundAndApprove() internal {
        for (uint256 i; i < quotes.length; ++i) {
            uint256 funds = 100_000 * 10 ** decimals[i];
            deal(quotes[i], CREATOR, funds);
            deal(quotes[i], ALICE, funds);
            vm.startPrank(CREATOR);
            IERC20(quotes[i]).approve(address(factory), type(uint256).max);
            IERC20(quotes[i]).approve(address(router), type(uint256).max);
            vm.stopPrank();
            vm.startPrank(ALICE);
            IERC20(quotes[i]).approve(address(router), type(uint256).max);
            IERC20(quotes[i]).approve(address(exactRouter), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _params(uint256 n) internal view returns (PluggedAdvancedFactory.LaunchParams memory p) {
        p.name = "Plugged Advanced";
        p.symbol = "PLUG";
        p.supply = SUPPLY;
        p.capToleranceBps = 100;
        p.salt = bytes32(uint256(1));
        p.minShareForQueue = 1 ether;
        p.metadata = LaunchMetadata(keccak256("image"), bytes32(0), bytes32(0));
        p.recipients = new address[](2);
        p.recipients[0] = ALICE;
        p.recipients[1] = BOB;
        p.sharesBps = new uint16[](2);
        p.sharesBps[0] = 6000;
        p.sharesBps[1] = 4000;
        p.markets = new PluggedAdvancedFactory.MarketParams[](n);
        for (uint256 i; i < n; ++i) {
            uint256 unit = 10 ** decimals[i];
            p.markets[i] = PluggedAdvancedFactory.MarketParams(
                quotes[i], 1000 * unit, 10_000 * unit, 10 * unit, 1, 60, 300, 300, 0, 5000, 0, 0
            );
        }
    }

    function _launch(PluggedAdvancedFactory.LaunchParams memory p)
        internal
        returns (PluggedAdvancedToken token)
    {
        vm.prank(CREATOR);
        (address deployed,) = factory.launch(p);
        token = PluggedAdvancedToken(deployed);
    }

    function _key(address token, address quote) internal view returns (PoolKey memory) {
        bool first = token < quote;
        return PoolKey(
            Currency.wrap(first ? token : quote),
            Currency.wrap(first ? quote : token),
            0,
            60,
            IHooks(address(hook))
        );
    }

    function _buy(PluggedAdvancedToken token, uint256 market, uint256 amount) internal returns (uint256) {
        PoolKey memory key = _key(address(token), quotes[market]);
        vm.prank(ALICE);
        return router.swap(key, address(token) > quotes[market], amount, 1, ALICE);
    }

    function _saltFor(bool tokenFirst, uint256 n) internal view returns (bytes32) {
        for (uint256 i = 1; i < 100_000; ++i) {
            address token = factory.predictTokenAddressFor(CREATOR, bytes32(i));
            bool matches = true;
            for (uint256 j; j < n; ++j) {
                if ((token < quotes[j]) != tokenFirst) matches = false;
            }
            if (matches) return bytes32(i);
        }
        revert("no directional salt");
    }
}

contract AdvancedFactoryTest is AdvancedHarness {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function testCanonicalDuplicateIgnoresMetadataSaltWalletsAndMarketOrder() public {
        PluggedAdvancedFactory.LaunchParams memory p = _params(2);
        bytes32 economics = factory.economicsHash(p);
        PluggedAdvancedToken token = _launch(p);
        assertEq(token.name(), "PLUGGED ADVANCED");
        p.name = " \tplugged   advanced\n";
        p.symbol = "plug";
        p.salt = bytes32(uint256(2));
        p.metadata.infoCid = keccak256("different social links");
        p.recipients[0] = address(0x123);
        p.recipients[1] = address(0x456);
        (p.sharesBps[0], p.sharesBps[1]) = (p.sharesBps[1], p.sharesBps[0]);
        (p.markets[0], p.markets[1]) = (p.markets[1], p.markets[0]);
        assertEq(factory.economicsHash(p), economics);
        bytes32 key = factory.registry().fingerprint(p.symbol, p.name, economics);
        address predicted = factory.predictTokenAddressFor(CREATOR, p.salt);
        vm.expectRevert(
            abi.encodeWithSelector(PluggedLaunchRegistry.DuplicateLaunch.selector, key, address(token))
        );
        _launch(p);
        assertEq(predicted.code.length, 0);
        assertEq(factory.launchCount(), 1);
    }

    function testDifferentValidatedEconomicsPermitSameNameAndTicker() public {
        PluggedAdvancedFactory.LaunchParams memory p = _params(1);
        bytes32 oldHash = factory.economicsHash(p);
        PluggedAdvancedToken first = _launch(p);
        p.markets[0].feeBps = 400;
        p.salt = bytes32(uint256(2));
        assertNotEq(factory.economicsHash(p), oldHash);
        PluggedAdvancedToken second = _launch(p);
        assertNotEq(address(first), address(second));
        assertEq(first.symbol(), second.symbol());
        assertEq(factory.launchCount(), 2);
    }

    function testAdmissionToleranceCannotEvadeDuplicateButFeeChangeCan() public {
        _assertToleranceDuplicateAndFeeChange(1);
    }

    function testAdmissionToleranceExcludedForMultiplePriceableMarkets() public {
        _assertToleranceDuplicateAndFeeChange(2);
    }

    function testAdmissionToleranceExcludedWithFewerThanTwoPriceableMarkets() public {
        pairs.approvePairWithoutOracle(quotes[1], decimals[1]);
        _assertToleranceDuplicateAndFeeChange(2);
    }

    function _assertToleranceDuplicateAndFeeChange(uint256 markets) private {
        PluggedAdvancedFactory.LaunchParams memory p = _params(markets);
        p.capToleranceBps = 0;
        bytes32 economics = factory.economicsHash(p);
        PluggedAdvancedToken original = _launch(p);
        p.capToleranceBps = 200;
        p.salt = bytes32(uint256(2));
        assertEq(factory.economicsHash(p), economics);
        bytes32 identity = factory.registry().fingerprint(p.symbol, p.name, economics);
        vm.expectRevert(
            abi.encodeWithSelector(
                PluggedLaunchRegistry.DuplicateLaunch.selector, identity, address(original)
            )
        );
        _launch(p);
        assertEq(factory.launchCount(), 1);
        p.markets[0].feeBps = 400;
        assertNotEq(factory.economicsHash(p), economics);
        PluggedAdvancedToken changed = _launch(p);
        assertNotEq(address(changed), address(original));
        assertEq(factory.launchCount(), 2);
    }

    function testAtomicRollbackOnCapViolationAndRetry() public {
        PluggedAdvancedFactory.LaunchParams memory p = _params(2);
        for (uint256 i; i < 2; ++i) {
            p.markets[i].devBuyPairAmount *= 5;
        }
        bytes32 settings = factory.economicsHash(p);
        bytes32 key = factory.registry().fingerprint(p.symbol, p.name, settings);
        address predicted = factory.predictTokenAddressFor(CREATOR, p.salt);
        uint256 balance = IERC20(quotes[0]).balanceOf(CREATOR);
        vm.expectPartialRevert(PluggedAdvancedFactory.DevBuyTooLarge.selector);
        _launch(p);
        assertEq(factory.registry().tokenFor(key), address(0));
        assertEq(predicted.code.length, 0);
        assertEq(factory.launchCount(), 0);
        assertEq(IERC20(quotes[0]).balanceOf(CREATOR), balance);
        for (uint256 i; i < 2; ++i) {
            p.markets[i].devBuyPairAmount /= 5;
        }
        assertEq(address(_launch(p)), predicted);
    }

    function testVestingDoesNotBypassThreePercentCap() public {
        PluggedAdvancedFactory.LaunchParams memory p = _params(1);
        p.vestDuration = 30 days;
        p.vestCliff = 7 days;
        p.markets[0].devBuyPairAmount *= 5;
        vm.expectPartialRevert(PluggedAdvancedFactory.DevBuyTooLarge.selector);
        _launch(p);
        p.markets[0].devBuyPairAmount /= 5;
        PluggedAdvancedToken token = _launch(p);
        address vault = factory.vaultOf(address(token));
        assertGt(token.balanceOf(vault), 0);
        assertFalse(token.exemptFromMaxWallet(vault));
        assertFalse(token.exemptFromMaxWallet(CREATOR));
        uint256 locked = token.balanceOf(vault);
        uint256 walletCap = token.maxWallet();
        // Exercise inbound holding enforcement on an actual Carbon vest release.
        vm.prank(address(manager));
        token.transfer(CREATOR, walletCap);
        skip(31 days);
        vm.expectPartialRevert(PluggedAdvancedToken.MaxWalletExceeded.selector);
        MultiVestingVault(vault).release();
        assertEq(token.balanceOf(vault), locked);
        vm.prank(CREATOR);
        token.transfer(BOB, locked);
        MultiVestingVault(vault).release();
        assertEq(token.balanceOf(CREATOR), token.maxWallet());
        assertEq(token.balanceOf(vault), 0);
    }

    function testCapAppliesToConduitDeliveryTransfersAndTransferFrom() public {
        PluggedAdvancedToken token = _launch(_params(1));
        uint256 cap = token.maxWallet();
        assertEq(cap, SUPPLY * 300 / 10_000);
        vm.prank(address(manager));
        token.transfer(ALICE, cap);
        vm.prank(ALICE);
        token.transfer(ALICE, cap); // no balance increase
        vm.prank(address(manager));
        token.transfer(address(factory), 2);
        vm.prank(address(factory));
        vm.expectPartialRevert(PluggedAdvancedToken.MaxWalletExceeded.selector);
        token.transfer(ALICE, 1);
        vm.startPrank(CREATOR);
        token.approve(BOB, 1);
        vm.expectPartialRevert(PluggedAdvancedToken.MaxWalletExceeded.selector);
        token.transfer(ALICE, 1);
        vm.stopPrank();
        vm.prank(BOB);
        vm.expectPartialRevert(PluggedAdvancedToken.MaxWalletExceeded.selector);
        token.transferFrom(CREATOR, ALICE, 1);
        assertEq(token.allowance(CREATOR, BOB), 1);
        vm.startPrank(ALICE);
        token.approve(address(router), cap / 2);
        uint256 received =
            router.swap(_key(address(token), quotes[0]), address(token) < quotes[0], cap / 2, 1, ALICE);
        vm.stopPrank();
        assertGt(received, 0, "a capped wallet can sell");
    }

    function testAllFourPoolsSweepToTheirOwnSplittersAndStreamHolders() public {
        PluggedAdvancedToken token = _launch(_params(4));
        assertEq(factory.poolsOf(address(token)).length, 4);
        assertEq(token.ledger().marketCount(), 4);
        for (uint256 i; i < 4; ++i) {
            PoolKey memory key = _key(address(token), quotes[i]);
            assertGt(manager.getLiquidity(key.toId()), 0);
            uint256 charged = hook.pendingFees(key.toId());
            assertGt(charged, 0);
            uint256 platformBefore = IERC20(quotes[i]).balanceOf(PLATFORM);
            uint256 keeperBefore = IERC20(quotes[i]).balanceOf(address(this));
            hook.sweep(key);
            PluggedFeeSplitter splitter =
                PluggedFeeSplitter(payable(factory.splitterOf(address(token), quotes[i])));
            uint256 creatorFees = IERC20(quotes[i]).balanceOf(address(splitter));
            uint256 holderFees = IERC20(quotes[i]).balanceOf(address(token.ledger()));
            assertGt(creatorFees, 0);
            assertGt(holderFees, 0);
            assertEq(
                creatorFees + holderFees + IERC20(quotes[i]).balanceOf(PLATFORM) - platformBefore
                    + IERC20(quotes[i]).balanceOf(address(this)) - keeperBefore,
                charged
            );
            uint256 beforeAlice = IERC20(quotes[i]).balanceOf(ALICE);
            uint256 claim = splitter.claimable(ALICE);
            assertGt(claim, 0);
            splitter.release(ALICE);
            assertEq(IERC20(quotes[i]).balanceOf(ALICE) - beforeAlice, claim);
            assertEq(splitter.claimable(ALICE), 0);
            assertEq(IERC20(quotes[i]).balanceOf(address(factory)), 0);
        }
        skip(25 hours);
        BasketLedger ledger = token.ledger();
        for (uint256 i; i < 4; ++i) {
            uint256 owed = token.ledger().withdrawableOf(CREATOR, quotes[i]);
            assertGt(owed, 0);
            uint256 beforeCreator = IERC20(quotes[i]).balanceOf(CREATOR);
            vm.prank(CREATOR);
            ledger.withdrawOne(quotes[i]);
            assertEq(IERC20(quotes[i]).balanceOf(CREATOR) - beforeCreator, owed);
        }
        assertEq(token.balanceOf(address(factory)), 0);
    }

    function testBothOrderingsAndAllFourSwapShapes() public {
        for (uint256 direction; direction < 2; ++direction) {
            PluggedAdvancedFactory.LaunchParams memory p = _params(1);
            p.salt = _saltFor(direction == 0, 1);
            p.name = direction == 0 ? "Currency Zero" : "Currency One";
            PluggedAdvancedToken token = _launch(p);
            assertEq(address(token) < quotes[0], direction == 0);
            PoolKey memory key = _key(address(token), quotes[0]);
            bool buyDirection = address(token) > quotes[0];
            uint256 feeBefore = hook.pendingFees(key.toId());
            uint256 bought = _buy(token, 0, 2 * 10 ** decimals[0]);
            assertGt(bought, 0);
            assertGt(hook.pendingFees(key.toId()), feeBefore);
            vm.startPrank(ALICE);
            token.approve(address(router), type(uint256).max);
            token.approve(address(exactRouter), type(uint256).max);
            router.swap(key, !buyDirection, bought / 4, 1, ALICE);
            assertGt(hook.pendingTokenFees(key.toId()), 0);
            exactRouter.swap(
                key,
                SwapParams(
                    buyDirection,
                    int256(bought / 4),
                    buyDirection ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                ),
                PoolSwapTest.TestSettings(false, false),
                ""
            );
            uint256 tokenFees = hook.pendingTokenFees(key.toId());
            exactRouter.swap(
                key,
                SwapParams(
                    !buyDirection,
                    int256(10 ** decimals[0] / 10),
                    !buyDirection ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                ),
                PoolSwapTest.TestSettings(false, false),
                ""
            );
            vm.stopPrank();
            assertGt(hook.pendingTokenFees(key.toId()), tokenFees);
            assertLe(token.balanceOf(ALICE), token.maxWallet());
            hook.sweep(key); // exercises the unchanged Carbon sell-fee conversion
            assertGt(IERC20(quotes[0]).balanceOf(factory.splitterOf(address(token), quotes[0])), 0);
        }
    }

    function testInvalidEconomicsCannotProduceAnIdentity() public {
        PluggedAdvancedFactory.LaunchParams memory p = _params(1);
        p.markets[0].feeBps = 100;
        vm.expectRevert(PluggedAdvancedFactory.InvalidEconomics.selector);
        factory.economicsHash(p);
        p.markets[0].feeBps = 300;
        p.markets[0].openingFeeBps = 900;
        vm.expectRevert(PluggedAdvancedFactory.InvalidEconomics.selector);
        factory.economicsHash(p);
        p.markets[0].openingFeeBps = 0;
        p.vestCliff = 1;
        vm.expectRevert(PluggedAdvancedFactory.InvalidEconomics.selector);
        factory.economicsHash(p);
        p.vestCliff = 0;
        p.recipients[1] = p.recipients[0];
        vm.expectRevert(PluggedAdvancedFactory.InvalidRecipients.selector);
        factory.economicsHash(p);
    }

    function testOracleDispersionAndDuplicateQuotesRejected() public {
        PluggedAdvancedFactory.LaunchParams memory p = _params(2);
        p.markets[1].openingMarketCap *= 2;
        vm.expectRevert(PluggedAdvancedFactory.OpeningsDiverge.selector);
        _launch(p);
        p.markets[1] = p.markets[0];
        vm.expectPartialRevert(PluggedAdvancedFactory.DuplicateMarket.selector);
        _launch(p);
    }

    function testCommunityOnlyNeedsNoRecipientAndSealedImplementation() public {
        PluggedAdvancedFactory.LaunchParams memory p = _params(1);
        p.markets[0].creatorBps = 0;
        p.recipients = new address[](0);
        p.sharesBps = new uint16[](0);
        PluggedAdvancedToken token = _launch(p);
        assertEq(factory.splitterOf(address(token), quotes[0]), address(0));
        hook.sweep(_key(address(token), quotes[0]));
        assertGt(IERC20(quotes[0]).balanceOf(address(token.ledger())), 0);
        PluggedAdvancedToken.InitParams memory init;
        vm.expectRevert(PluggedAdvancedToken.AlreadyInitialized.selector);
        implementation.initialize(init);
        vm.expectRevert(PluggedAdvancedToken.AlreadyInitialized.selector);
        token.initialize(init);
        vm.expectRevert(PluggedAdvancedToken.OnlyConduit.selector);
        token.wireFeeds(new address[](0), new address[](0));
        vm.expectRevert(PluggedAdvancedFactory.OnlyPoolManager.selector);
        factory.unlockCallback("");
    }

    function testFuzzValidFeeChangesIdentity(uint16 fee) public view {
        fee = uint16(bound(fee, 101, 1000));
        PluggedAdvancedFactory.LaunchParams memory p = _params(1);
        bytes32 original = factory.economicsHash(p);
        p.markets[0].feeBps = fee;
        bytes32 changed = factory.economicsHash(p);
        if (fee == 300) assertEq(changed, original);
        else assertNotEq(changed, original);
    }
}
