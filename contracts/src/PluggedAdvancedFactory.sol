// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/libraries/FixedPoint96.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {FeeHook} from "carbon/src/FeeHook.sol";
import {PairRegistry} from "carbon/src/PairRegistry.sol";
import {LaunchMetadata} from "carbon/src/types/LaunchMetadata.sol";
import {BasketLedger} from "carbon/src/multi/BasketLedger.sol";
import {MultiDeployer} from "carbon/src/multi/MultiDeployer.sol";
import {MultiVestingVault} from "carbon/src/multi/MultiVestingVault.sol";
import {PluggedAdvancedToken} from "./PluggedAdvancedToken.sol";
import {PluggedLaunchRegistry} from "./PluggedLaunchRegistry.sol";
import {PluggedAdvancedFeed} from "./PluggedAdvancedFeed.sol";
import {PluggedAdvancedSplitter} from "./PluggedAdvancedSplitter.sol";

/// @notice Separate strict Plugged launch path adapting Carbon MultiLauncher's seeding algorithm.
/// @dev Uses unchanged Carbon FeeHook and vesting, recovery-enabled feed/splitter adapters,
///      and a dust-fixed Carbon-compatible ledger.
///      All liquidity positions belong
///      to this factory; no negative liquidityDelta, owner, upgrade or withdrawal path exists.
///      The factory derives identity from validated economics, never a caller-provided hash.
contract PluggedAdvancedFactory is IUnlockCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint16 public constant MAX_WALLET_BPS = 300;
    uint16 public constant BPS = 10_000;
    uint256 public constant MAX_MARKETS = 4;
    IPoolManager public immutable poolManager;
    FeeHook public immutable feeHook;
    PairRegistry public immutable pairRegistry;
    address public immutable tokenImplementation;
    MultiDeployer public immutable deployer;
    PluggedLaunchRegistry public immutable registry;

    struct MarketParams {
        address pair;
        uint256 openingMarketCap;
        uint256 graduationThreshold;
        uint256 devBuyPairAmount;
        uint256 minPushPayout;
        int24 tickSpacing;
        uint16 feeBps;
        uint16 sellFeeBps;
        uint16 burnBps;
        uint16 creatorBps;
        uint32 openingWindow;
        uint16 openingFeeBps;
    }

    struct LaunchParams {
        string name;
        string symbol;
        uint256 supply;
        uint64 vestDuration;
        uint64 vestCliff;
        uint16 capToleranceBps;
        bytes32 salt;
        uint256 minShareForQueue;
        LaunchMetadata metadata;
        MarketParams[] markets;
        address[] recipients;
        uint16[] sharesBps;
    }

    struct SeedData {
        PoolKey[] keys;
        int24[] ticks;
        uint256[] devBuys;
        address token;
        uint256 sliceSupply;
        address creator;
        uint64 vestDuration;
        uint64 vestCliff;
    }

    struct LaunchRecord {
        address token;
        address creator;
        uint64 launchedAt;
        uint8 marketCount;
    }
    LaunchRecord[] public launches;
    mapping(address => uint256) public launchIndexPlusOne;
    mapping(address => address) public ledgerOf;
    mapping(address => address) public vaultOf;
    mapping(address => mapping(address => address)) public splitterOf;
    mapping(address => PoolId[]) private _poolsOf;
    mapping(address => address[]) private _pairsOf;

    error InvalidWiring();
    error InvalidEconomics();
    error InvalidRecipients();
    error PairNotApproved(address pair);
    error DuplicateMarket(address pair);
    error OpeningBuyRequired(uint256 given, uint256 minimum);
    error OpeningPriceOutOfRange();
    error OpeningsDiverge();
    error OnlyPoolManager();
    error UnsupportedTokenBehavior();
    error SettlementShortfall(uint256 owed, uint256 credited);
    error LauncherRetainedFunds();
    error BornGraduated(uint256 threshold, uint256 marketCap);
    error DevBuyTooLarge(uint256 bought, uint256 cap);
    event AdvancedLaunched(
        address indexed token,
        address indexed creator,
        bytes32 indexed economics,
        address ledger,
        uint8 marketCount,
        uint8 priceableMarkets
    );
    event MarketOpened(
        address indexed token, address indexed pair, PoolId poolId, address feed, address splitter
    );
    event VaultCreated(
        address indexed token,
        address indexed vault,
        address indexed beneficiary,
        uint64 vestCliff,
        uint64 vestDuration
    );

    constructor(
        IPoolManager manager,
        FeeHook hook,
        PairRegistry pairs,
        address implementation,
        MultiDeployer satellites
    ) {
        if (
            address(manager).code.length == 0 || address(hook).code.length == 0
                || address(pairs).code.length == 0 || implementation.code.length == 0
                || address(satellites).code.length == 0 || hook.launcher() != address(this)
                || address(hook.poolManager()) != address(manager)
                || PluggedAdvancedToken(implementation).MAX_WALLET_BPS() != MAX_WALLET_BPS
        ) revert InvalidWiring();
        poolManager = manager;
        feeHook = hook;
        pairRegistry = pairs;
        tokenImplementation = implementation;
        deployer = satellites;
        registry = new PluggedLaunchRegistry(address(this));
    }

    function launch(LaunchParams memory p)
        external
        nonReentrant
        returns (address token, uint8 priceableMarkets)
    {
        _sortMarkets(p.markets);
        _validate(p);
        priceableMarkets = _assertOpeningsAgree(p);
        bytes32 settings = _economicsHash(p);
        p.name = registry.canonicalName(p.name);
        p.symbol = registry.canonicalTicker(p.symbol);
        token = _clone(p);
        // Reserve only after actual code exists, before any quote transfer. Reverts roll back the
        // clone, ledger, reservation, feeds, splitters, pools and funds together.
        registry.register(p.symbol, p.name, settings, token);
        address ledger = address(PluggedAdvancedToken(token).ledger());
        ledgerOf[token] = ledger;
        SeedData memory d = _openMarkets(p, token, ledger, settings);
        if (p.vestDuration != 0) {
            address vault = deployer.deployVault(token, ledger, msg.sender, address(this));
            vaultOf[token] = vault;
            emit VaultCreated(token, vault, msg.sender, p.vestCliff, p.vestDuration);
        }
        poolManager.unlock(abi.encode(d));
        if (IERC20(token).balanceOf(address(this)) != 0) revert LauncherRetainedFunds();
        for (uint256 i; i < p.markets.length; ++i) {
            if (IERC20(p.markets[i].pair).balanceOf(address(this)) != 0) revert LauncherRetainedFunds();
            uint256 cap = feeHook.marketCapOf(d.keys[i].toId());
            if (cap >= p.markets[i].graduationThreshold) {
                revert BornGraduated(p.markets[i].graduationThreshold, cap);
            }
        }
        launches.push(LaunchRecord(token, msg.sender, uint64(block.timestamp), uint8(p.markets.length)));
        launchIndexPlusOne[token] = launches.length;
        emit AdvancedLaunched(token, msg.sender, settings, ledger, uint8(p.markets.length), priceableMarkets);
    }

    function _clone(LaunchParams memory p) private returns (address token) {
        uint256 n = p.markets.length;
        address[] memory currencies = new address[](n);
        uint256[] memory floors = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            currencies[i] = p.markets[i].pair;
            floors[i] = p.markets[i].minPushPayout;
        }
        token = Clones.cloneDeterministic(tokenImplementation, keccak256(abi.encode(msg.sender, p.salt)));
        PluggedAdvancedToken(token)
            .initialize(
                PluggedAdvancedToken.InitParams({
                    name_: p.name,
                    symbol_: p.symbol,
                    supply: p.supply,
                    recipient: address(this),
                    currencies: currencies,
                    minPushPayout: floors,
                    controller: address(feeHook),
                    poolManager_: address(poolManager),
                    minShareForQueue: p.minShareForQueue,
                    metadata: p.metadata
                })
            );
    }

    function _openMarkets(LaunchParams memory p, address token, address ledger, bytes32 settings)
        private
        returns (SeedData memory d)
    {
        uint256 n = p.markets.length;
        d = SeedData(
            new PoolKey[](n),
            new int24[](n),
            new uint256[](n),
            token,
            p.supply / n,
            msg.sender,
            p.vestDuration,
            p.vestCliff
        );
        address[] memory currencies = new address[](n);
        address[] memory feeds = new address[](n);
        for (uint256 i; i < n; ++i) {
            MarketParams memory m = p.markets[i];
            uint256 beforeBalance = IERC20(m.pair).balanceOf(address(this));
            IERC20(m.pair).safeTransferFrom(msg.sender, address(this), m.devBuyPairAmount);
            // A taxed quote changes the agreed opening economics. Refuse it, rather than hashing
            // one amount while executing another. Carbon's exact settlement follows below.
            if (IERC20(m.pair).balanceOf(address(this)) - beforeBalance != m.devBuyPairAmount) {
                revert UnsupportedTokenBehavior();
            }
            d.devBuys[i] = m.devBuyPairAmount;
            bool first = token < m.pair;
            PoolKey memory key = PoolKey(
                Currency.wrap(first ? token : m.pair),
                Currency.wrap(first ? m.pair : token),
                0,
                m.tickSpacing,
                IHooks(address(feeHook))
            );
            address feed = address(new PluggedAdvancedFeed(BasketLedger(ledger), m.pair, address(feeHook)));
            // Even a zero creator-share config needs a nonzero recipient for Carbon validation.
            address recipient = address(0xdEaD);
            if (m.creatorBps != 0) {
                recipient = address(
                    new PluggedAdvancedSplitter(m.pair, p.recipients, p.sharesBps, settings, address(feeHook))
                );
                splitterOf[token][m.pair] = recipient;
            }
            feeHook.configurePoolFull(
                key,
                FeeHook.FeeSetup({
                    distributor: feed,
                    pairCurrency: Currency.wrap(m.pair),
                    feeBps: m.feeBps,
                    sellFeeBps: m.sellFeeBps,
                    burnBps: m.burnBps,
                    creator: recipient,
                    creatorBps: m.creatorBps,
                    rewardCurrency: Currency.wrap(address(0)),
                    openingWindow: m.openingWindow,
                    openingFeeBps: m.openingFeeBps
                })
            );
            feeHook.configureGraduation(key, m.graduationThreshold, d.sliceSupply);
            d.ticks[i] = _openingTick(d.sliceSupply, m.openingMarketCap, first, m.tickSpacing);
            poolManager.initialize(key, TickMath.getSqrtPriceAtTick(d.ticks[i]));
            d.keys[i] = key;
            currencies[i] = m.pair;
            feeds[i] = feed;
            _poolsOf[token].push(key.toId());
            _pairsOf[token].push(m.pair);
            emit MarketOpened(token, m.pair, key.toId(), feed, splitterOf[token][m.pair]);
        }
        PluggedAdvancedToken(token).wireFeeds(currencies, feeds);
    }

    /// @notice Commitment to validated economics, independent of payout-wallet identity and metadata.
    function economicsHash(LaunchParams memory p) external view returns (bytes32) {
        _sortMarkets(p.markets);
        _validate(p);
        _assertOpeningsAgree(p);
        return _economicsHash(p);
    }

    function _economicsHash(LaunchParams memory p) private pure returns (bytes32) {
        // Wallet reassignment and recipient ordering cannot evade duplicate rejection. The
        // allocation multiset is economic; the identities assigned to those shares are not.
        // capToleranceBps is only an admission guard, not a term of the resulting pools.
        uint16[] memory shares = new uint16[](p.sharesBps.length);
        for (uint256 i; i < shares.length; ++i) {
            uint16 value = p.sharesBps[i];
            uint256 j = i;
            while (j > 0 && shares[j - 1] > value) {
                shares[j] = shares[j - 1];
                --j;
            }
            shares[j] = value;
        }
        return keccak256(
            abi.encode(
                keccak256("PLUGGED_ADVANCED_ECONOMICS_V1"),
                p.supply,
                MAX_WALLET_BPS,
                p.vestDuration,
                p.vestCliff,
                p.minShareForQueue,
                p.markets,
                shares
            )
        );
    }

    function _sortMarkets(MarketParams[] memory markets) private pure {
        if (markets.length == 0 || markets.length > MAX_MARKETS) revert InvalidEconomics();
        for (uint256 i = 1; i < markets.length; ++i) {
            MarketParams memory m = markets[i];
            uint256 j = i;
            while (j > 0 && markets[j - 1].pair > m.pair) {
                markets[j] = markets[j - 1];
                --j;
            }
            markets[j] = m;
        }
    }

    function _validate(LaunchParams memory p) private view {
        registry.canonicalName(p.name);
        registry.canonicalTicker(p.symbol);
        uint256 n = p.markets.length;
        if (
            n == 0 || n > MAX_MARKETS || p.supply < 1e18 || p.supply % n != 0 || p.capToleranceBps > 200
                || p.metadata.imageCid == bytes32(0) || (p.vestDuration == 0 && p.vestCliff != 0)
                || (p.vestDuration != 0 && (p.vestDuration < 7 days || p.vestCliff > p.vestDuration))
        ) revert InvalidEconomics();
        bool creatorEnabled;
        for (uint256 i; i < n; ++i) {
            MarketParams memory m = p.markets[i];
            if (m.pair.code.length == 0 || !pairRegistry.isApproved(m.pair)) revert PairNotApproved(m.pair);
            if (i > 0 && p.markets[i - 1].pair == m.pair) revert DuplicateMarket(m.pair);
            if (
                m.openingMarketCap == 0 || m.graduationThreshold <= m.openingMarketCap
                    || m.tickSpacing < TickMath.MIN_TICK_SPACING || m.tickSpacing > TickMath.MAX_TICK_SPACING
                    || m.devBuyPairAmount > uint256(uint128(type(int128).max))
                    || m.feeBps <= feeHook.PLATFORM_VOLUME_BPS() || m.feeBps > feeHook.MAX_FEE_BPS()
                    || m.sellFeeBps > feeHook.MAX_FEE_BPS()
                    || (m.sellFeeBps != 0 && m.sellFeeBps <= feeHook.PLATFORM_VOLUME_BPS())
                    || uint256(m.creatorBps) + m.burnBps > BPS
                    || m.openingWindow > feeHook.MAX_OPENING_WINDOW()
                    || (m.openingWindow == 0 && m.openingFeeBps != 0)
                    || (m.openingWindow != 0
                        && (m.openingFeeBps <= m.feeBps || m.openingFeeBps > feeHook.MAX_OPENING_FEE_BPS()))
            ) revert InvalidEconomics();
            uint256 floor = minDevBuyFor(m.pair);
            if (m.devBuyPairAmount < floor) revert OpeningBuyRequired(m.devBuyPairAmount, floor);
            // Preserve Carbon's unvested input guard; the output-side 3% rule is stricter and
            // applies to both vested and unvested buys across all pools together.
            if (p.vestDuration == 0 && m.devBuyPairAmount > Math.mulDiv(m.openingMarketCap, 1000, BPS)) {
                revert InvalidEconomics();
            }
            _openingTick(p.supply / n, m.openingMarketCap, true, m.tickSpacing);
            _openingTick(p.supply / n, m.openingMarketCap, false, m.tickSpacing);
            if (m.creatorBps != 0) creatorEnabled = true;
        }
        uint256 count = p.recipients.length;
        if (count != p.sharesBps.length || count > 100 || (creatorEnabled ? count == 0 : count != 0)) {
            revert InvalidRecipients();
        }
        uint256 sum;
        for (uint256 i; i < count; ++i) {
            if (p.recipients[i] == address(0) || p.sharesBps[i] == 0) revert InvalidRecipients();
            for (uint256 j; j < i; ++j) {
                if (p.recipients[j] == p.recipients[i]) revert InvalidRecipients();
            }
            sum += p.sharesBps[i];
        }
        if (creatorEnabled && sum != BPS) revert InvalidRecipients();
    }

    function minDevBuyFor(address pair) public view returns (uint256) {
        uint8 decimals = pairRegistry.pairConfig(pair).tokenDecimals;
        if (decimals > 38) revert InvalidEconomics();
        return decimals >= 6 ? 10 ** (uint256(decimals) - 6) : 1;
    }

    /// @dev Exact Carbon MultiLauncher USD dispersion comparison. Unpriceable quotes are counted
    ///      as unproven rather than fabricated. This does not promise equality after tick snapping.
    function _assertOpeningsAgree(LaunchParams memory p) private view returns (uint8 priceable) {
        uint256 capLow = type(uint256).max;
        uint256 capHigh;
        uint256 buyLow = type(uint256).max;
        uint256 buyHigh;
        for (uint256 i; i < p.markets.length; ++i) {
            MarketParams memory m = p.markets[i];
            if (!pairRegistry.isPriceable(m.pair)) continue;
            ++priceable;
            uint256 cap = _usdOf(m.pair, m.openingMarketCap);
            uint256 buy = _usdOf(m.pair, m.devBuyPairAmount);
            capLow = Math.min(capLow, cap);
            capHigh = Math.max(capHigh, cap);
            buyLow = Math.min(buyLow, buy);
            buyHigh = Math.max(buyHigh, buy);
        }
        if (
            priceable >= 2
                && (!_within(capLow, capHigh, p.capToleranceBps)
                    || !_within(buyLow, buyHigh, p.capToleranceBps))
        ) revert OpeningsDiverge();
    }

    function _within(uint256 low, uint256 high, uint16 tolerance) private pure returns (bool) {
        return high - low <= Math.mulDiv(low, tolerance, BPS);
    }

    function _usdOf(address pair, uint256 amount) private view returns (uint256) {
        (uint256 price, uint8 decimals) = pairRegistry.priceUsd(pair);
        uint256 scaled = FullMath.mulDiv(amount, 1e18, 10 ** pairRegistry.pairConfig(pair).tokenDecimals);
        return FullMath.mulDiv(scaled, price, 10 ** decimals);
    }

    /// @dev Carbon's exact sqrt-ratio and directional tick-snapping algorithm.
    function _openingTick(uint256 supply, uint256 cap, bool first, int24 spacing)
        private
        pure
        returns (int24)
    {
        (uint256 a0, uint256 a1) = first ? (supply, cap) : (cap, supply);
        uint256 price = Math.sqrt(FullMath.mulDiv(a1, FixedPoint96.Q96 * FixedPoint96.Q96, a0));
        if (price < TickMath.MIN_SQRT_PRICE || price >= TickMath.MAX_SQRT_PRICE) {
            revert OpeningPriceOutOfRange();
        }
        int24 tick = TickMath.getTickAtSqrtPrice(uint160(price));
        int24 aligned = (tick / spacing) * spacing;
        if (tick < 0 && tick % spacing != 0) aligned -= spacing;
        if (first && aligned < tick) aligned += spacing;
        if (aligned <= TickMath.minUsableTick(spacing) || aligned >= TickMath.maxUsableTick(spacing)) {
            revert OpeningPriceOutOfRange();
        }
        return aligned;
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        SeedData memory d = abi.decode(raw, (SeedData));
        for (uint256 i; i < d.keys.length; ++i) {
            _seed(d, i);
        }
        // Burn only actual unseeded dust, before buying, so it cannot become an undisclosed
        // creator allocation. Carbon's post-buy balance delivery otherwise includes that dust.
        uint256 dust = IERC20(d.token).balanceOf(address(this));
        if (dust != 0) IERC20(d.token).safeTransfer(address(0xdEaD), dust);
        for (uint256 i; i < d.keys.length; ++i) {
            PoolKey memory key = d.keys[i];
            bool zeroForOne = Currency.unwrap(key.currency1) == d.token;
            BalanceDelta delta = poolManager.swap(
                key,
                SwapParams(
                    zeroForOne,
                    -int256(d.devBuys[i]),
                    zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                ),
                ""
            );
            _settle(key.currency0, delta.amount0());
            _settle(key.currency1, delta.amount1());
        }
        uint256 bought = IERC20(d.token).balanceOf(address(this));
        uint256 cap = PluggedAdvancedToken(d.token).maxWallet();
        if (bought > cap) revert DevBuyTooLarge(bought, cap);
        address vault = vaultOf[d.token];
        if (bought != 0) {
            IERC20(d.token).safeTransfer(vault == address(0) ? d.creator : vault, bought);
            if (vault != address(0)) {
                if (bought > type(uint128).max) revert InvalidEconomics();
                MultiVestingVault(vault)
                    .addSchedule(uint128(bought), uint64(block.timestamp), d.vestCliff, d.vestDuration);
            }
        }
        for (uint256 i; i < d.keys.length; ++i) {
            address pair = Currency.unwrap(d.keys[i].currency0) == d.token
                ? Currency.unwrap(d.keys[i].currency1)
                : Currency.unwrap(d.keys[i].currency0);
            uint256 left = IERC20(pair).balanceOf(address(this));
            if (left != 0) IERC20(pair).safeTransfer(d.creator, left);
        }
        return "";
    }

    function _seed(SeedData memory d, uint256 i) private {
        PoolKey memory key = d.keys[i];
        bool first = Currency.unwrap(key.currency0) == d.token;
        int24 lower = first ? d.ticks[i] : TickMath.minUsableTick(key.tickSpacing);
        int24 upper = first ? TickMath.maxUsableTick(key.tickSpacing) : d.ticks[i];
        uint128 liquidity = first
            ? LiquidityAmounts.getLiquidityForAmount0(
                TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), d.sliceSupply
            )
            : LiquidityAmounts.getLiquidityForAmount1(
                TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), d.sliceSupply
            );
        if (liquidity == 0) revert InvalidEconomics();
        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            key, ModifyLiquidityParams(lower, upper, int256(uint256(liquidity)), bytes32(0)), ""
        );
        _settle(key.currency0, delta.amount0());
        _settle(key.currency1, delta.amount1());
    }

    function _settle(Currency currency, int128 amount) private {
        if (amount > 0) {
            poolManager.take(currency, address(this), uint128(amount));
        } else if (amount < 0) {
            uint256 owed = uint256(-int256(amount));
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), owed);
            uint256 credited = poolManager.settle();
            if (credited != owed) revert SettlementShortfall(owed, credited);
        }
    }

    function launchCount() external view returns (uint256) {
        return launches.length;
    }

    function isOurs(address token) external view returns (bool) {
        return launchIndexPlusOne[token] != 0;
    }

    function poolsOf(address token) external view returns (PoolId[] memory) {
        return _poolsOf[token];
    }

    function pairsOf(address token) external view returns (address[] memory) {
        return _pairsOf[token];
    }

    function predictTokenAddress(bytes32 salt) external view returns (address) {
        return predictTokenAddressFor(msg.sender, salt);
    }

    function predictTokenAddressFor(address creator, bytes32 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(
            tokenImplementation, keccak256(abi.encode(creator, salt)), address(this)
        );
    }
}
