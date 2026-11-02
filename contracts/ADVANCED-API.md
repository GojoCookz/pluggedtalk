# Plugged Advanced API

This is a separate, undeployed factory/token path. Existing Carbon deployments do not gain these features.

## Deployment sequence

1. Deploy `PluggedAdvancedToken()` implementation and Carbon `MultiDeployer()` (or use a verified existing MultiDeployer).
2. Choose the verified PoolManager and PairRegistry, and the platform fee recipient.
3. Predict the advanced factory's CREATE address. Mine and deploy the **unchanged Carbon FeeHook** with constructor `(IPoolManager manager, address predictedFactory, address platformRecipient)`. Its low 14 address bits must be **0x20CC**. Reserve the factory nonce correctly around the hook deployment.
4. Deploy `PluggedAdvancedFactory(IPoolManager manager, FeeHook hook, PairRegistry pairs, address tokenImplementation, MultiDeployer satellites)`. The constructor deploys its own `PluggedLaunchRegistry(address(this))`; no external registry wiring or ownership transfer is needed. It checks the hook's launcher and PoolManager.

No referral configuration exists. No deployment/broadcast has been performed.

Foundry needs the additional remapping `carbon/=../../contracts/` alongside v4-core/periphery and OpenZeppelin. Tests and contracts import the exact existing source through this prefix. The WSL `/usr/local/bin/forge` currently forwards to the installed Windows `forge.exe`; relative imports outside the Foundry project failed in that wrapper, so the explicit remapping is necessary.

## Launch API

`launch(LaunchParams p) returns (address token, uint8 priceableMarkets)`.

`LaunchParams`: `string name, string symbol, uint256 supply, uint64 vestDuration, uint64 vestCliff, uint16 capToleranceBps, bytes32 salt, uint256 minShareForQueue, LaunchMetadata metadata, MarketParams[] markets, address[] recipients, uint16[] sharesBps`.

`MarketParams` matches Carbon MultiLauncher: `address pair, uint256 openingMarketCap, uint256 graduationThreshold, uint256 devBuyPairAmount, uint256 minPushPayout, int24 tickSpacing, uint16 feeBps, uint16 sellFeeBps, uint16 burnBps, uint16 creatorBps, uint32 openingWindow, uint16 openingFeeBps`.

Approve the factory for each quote's opening buy. Markets are sorted by quote address internally. One to four unique approved ERC-20 quotes are supported, with equal supply slices and Carbon's opening valuation checks. Holder dividends use a Plugged-local, ABI-compatible adaptation of Carbon BasketLedger plus `PluggedAdvancedFeed`; creator fees use one immutable `PluggedAdvancedSplitter` per quote, inheriting the existing PluggedFeeSplitter accounting unchanged. Recipients/shares may be empty only when every market has zero creator share. Recipient allocations total 10,000 BPS. The existing factory constructor is unchanged; the factory deploys both adapters directly and still uses Carbon MultiDeployer for vesting vaults.

The cap is fixed at 300 BPS of total supply and cannot be disabled. Creator and vesting vault are capped; deliveries from the factory do not bypass the cap. Only PoolManager, factory, hook, token, ledger and dead address are exempt. No arbitrary exemption setter exists. This limits each address, not ownership across multiple addresses.

`economicsHash(p)` validates parameters and returns the canonical economics commitment. Market order, salt, metadata, identity spelling, recipient wallet identities, and `capToleranceBps` do not affect it. Tolerance is still validated and enforced as an admission guard, but is not a term of the resulting pools and is excluded from the hash entirely. Sorted recipient-share amounts do affect it. Supply, vesting, dividend thresholds and all effective market economics are included. Name/ticker canonicalization uses PluggedLaunchRegistry. Registration and all deployments occur in one transaction; failed launches leave no reservation. The hash encoding changed before deployment; integrations must recompute it from the current factory.

Views: `registry()`, `poolManager()`, `feeHook()`, `pairRegistry()`, `tokenImplementation()`, `deployer()`, `predictTokenAddress(bytes32 salt)`, `poolsOf(token)`, `pairsOf(token)`, `splitterOf(token,pair)`, `ledgerOf(token)`, `vaultOf(token)`, `launchCount()`, `isOurs(token)`.

Token predictions namespace salts by creator: `predictTokenAddress(bytes32 salt)` predicts for msg.sender; `predictTokenAddressFor(address creator, bytes32 salt)` supports third-party preparation.

Carbon fees retain their exact source semantics: 1% platform-volume parameter, 10% normal fee ceiling, creator/burn validation, opening-fee decay, ERC-6909 accrual, keeper sweep and streamed holder rewards. The recipient share divides Carbon's creator payout, not gross swap volume. No reward conversion or mutable basket controller is introduced.

## Deferred Carbon payout recovery

Source-confirmed integration constraint: `FeeHook._payOut` records failed transfers in `stuckFees(currency, recipient)`, and `claimStuckFees(currency)` clears that liability before transferring **only to msg.sender** (`contracts/src/FeeHook.sol:1502–1549`). The original Carbon MarketFeed and PluggedFeeSplitter cannot initiate this claim. These existing contracts are unchanged.

Both advanced adapters expose `recoverStuckFees() returns (uint256 amount)`. Anyone can call it, with no hook, currency or recipient parameters. Immutable wiring selects the single hook and quote. `PluggedAdvancedFeed` claims as the feed, forwards verified funds to its fixed ledger, and credits the corresponding streamed holder bucket. `PluggedAdvancedSplitter` claims as the splitter; recovered funds enter its original cumulative-receipts accounting and can only be released to the original fixed recipients. `ledger.feedOf(quote)` and `factory.splitterOf(token,quote)` locate the adapters; both expose `hook()` and `currency()`.

Recovery shares a transient reentrancy guard with every other adapter money-moving entry point (`distribute`/`sync` for feeds, inherited `release` for splitters). Carbon clears its deferred entry before transfer; a failed transfer, funding verification or ledger forward reverts the complete recovery transaction and restores Carbon's liability. Repeat recovery with no deferred balance reverts `FeeHook.NothingStuck`. Feed `sync()` still forwards directly received funds without requiring a deferred hook entry.

The two failure paths are distinct: blacklisting the feed or splitter causes a failed initial payout and a deferred hook liability. Blacklisting only the holder ledger causes the feed's forward to revert; Carbon calls `distribute` directly, so the **entire sweep reverts**, preserving pending fees. Recovery does not change these Carbon semantics.

## Carbon ledger rounding finding and local fix

Stateful sweeps/top-ups/claims exposed a **1-base-unit holder-liability shortfall** in the unchanged Carbon `BasketLedger`. Its `_arm` computes a rounded-down rate, puts one whole unit in `pending`, and retains an existing magnified remainder, double-counting fractional stream dust on later top-ups. The pre-fix failure is preserved in `C:/Users/shies/AppData/Local/Temp/opencode/plugged-advanced-test3.log`.

`PluggedAdvancedLedger` is a separate local adaptation preserving Carbon's ABI and accounting except `_arm`: `newRate * window + newRemainder` equals exactly `addition * MAGNITUDE + oldRemainingTime * oldRate + oldRemainder`. It does not create a whole pending unit from fractional dust. `AdvancedLedger.t.sol` includes an unchanged-Carbon negative control and magnified-budget fuzz tests. The existing Carbon contracts are untouched; their deployed instances do not receive this fix. Final validation results will be recorded below.

Tooling note: the installed Forge formatter removed braces around two-statement inline `if`/`while` blocks, changing semantics. Those four blocks were repaired with explicit multiline braces and the full local suite rerun successfully. Avoid reintroducing inline multi-statement blocks. Use `forge fmt --check` before any further formatting.

Fork test: enable `PLUGGED_ADVANCED_FORK=true`. Default pin is the verified block 102855166; `PLUGGED_ADVANCED_FORK_BLOCK` accepts an explicitly supplied alternative pin. The public RPC prunes historical state quickly. Old-pin errors are infrastructure failures, not skips or passing fork evidence. Windows environment variables must be set before invoking the WSL wrapper (Linux-only variables are not forwarded into forge.exe).

Pinned fork with the recovery-enabled factory **passed at block 102855166**, chain 4663: four canonical quotes (USDG, cbBTC, WETH, AAPL), both token orderings, real PoolManager launch/buy/sell/sweep, collaborator claims and streamed holder claims. Test gas: 24,815,613; this covers two launches plus their trades/claims, not one launch's gas. The earlier pre-adapter run passed at block 102796324.

## Final validation evidence

- `AdvancedFactoryTest`: **14 passed**, identity fuzz **10,000 runs**. Three added regressions execute successful launches then prove tolerance-only changes reject as duplicates (single market, two priceable markets, and fewer than two priceable markets); changing an actual fee still permits a new launch.
- `AdvancedRecoveryTest`: **5 passed**. Exact Carbon `MockBlacklistERC20` plus the actual FeeHook reproduce deferred feed/splitter payouts with positive liabilities. Recovery pays only the fixed ledger/recipients, preserves all funds through blocked transfer/forward rollback, rejects redirection, and cannot double-claim. A separate callback-enabled subclass retains the exact blacklist behavior and proves nested recovery, feed sync and splitter release are rejected by the shared reentrancy guard.
- `AdvancedLedgerTest`: **5 passed**, magnified-budget fuzz **10,000 runs**. Includes original-Carbon negative control, blocked-recipient payout isolation, feed authority and exclusion/queue accounting.
- `AdvancedInvariantTest`: **2 passed**, each **256 runs × 64 calls = 16,384 calls**. Successful buy/sell/transfer/sweep/claim counters are checked in setup to reject vacuous coverage. Cap, supply conservation, independent splitter balances and holder solvency are asserted without rounding tolerances.
- Full advanced local run: **26 passed, 0 failed, 1 fork test skipped**. The fork was then enabled and executed separately: `AdvancedForkTest` **1 passed** with explicit block **102855166**, giving **27 passing tests across both invocations**. Earlier historical-pin attempts failed because the public RPC had pruned state.
- `forge fmt --check` passed for the changed factory, adapters and regression tests. `forge lint` on the changed factory/adapters exited successfully with **5 warnings and 16 notes**, no lint errors. Lint is not claimed warning-free.
- Compilation passed. `forge build --sizes` exits nonzero because Foundry 1.5.1 retains its Ethereum EIP-170 size gate even with Robinhood's execution limit configured. The explicit `bun tools/deployment-sizes.mjs` Robinhood gate passed after the recovery fixes and now explicitly includes both adapters. Runtime sizes: factory **29,016 B**, token **13,873 B**, ledger **7,378 B**. The factory exceeds Ethereum's standard 24,576-byte limit and requires Robinhood's **98,304-byte** runtime limit; no Ethereum deployment claim is made. Factory initcode is **32,210 B**. Adapter sizes: feed **1,709 B runtime / 2,000 B initcode**, splitter **2,852 B runtime / 4,027 B initcode**.
- **Coverage measurement blocked:** `forge coverage --ir-minimum` compiled, then Solar failed to resolve mixed Windows separators in imported dependencies (`src\\libraries/Hooks.sol` relative imports). No coverage percentage is available. WSL currently forwards to Windows `forge.exe`; a native-Linux Foundry coverage run remains outstanding. No scanners or external audit were run.

Logs are in `C:/Users/shies/AppData/Local/Temp/opencode/`: `plugged-advanced-all-final.log`, `plugged-advanced-ledger-final.log`, `plugged-advanced-fork-pinned.log`, `plugged-advanced-sizes.log`, `plugged-advanced-lint.log`, and `plugged-advanced-coverage.log`.

Current review-fix evidence: `plugged-advanced-review-final.log` (26 passing local tests), `plugged-advanced-review-fork.log` (passing fork), and `plugged-advanced-review-lint.log`. Executed through WSL with `forge test --skip script --match-contract Advanced.*Test -vv`, then the explicitly pinned fork invocation. No coverage percentage is claimed for the new adapters; the previously documented Solar blocker remains outstanding.

Only `PluggedAdvanced*.sol`, `Advanced*.t.sol`, and this API document were authored by this task. No commits, pushes, broadcasts, worktrees, ownership transfers, or edits to existing Carbon/program contracts were performed.
