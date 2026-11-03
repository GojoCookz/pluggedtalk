# Advanced runtime workstream (plugged-advanced-v1)

Connects the already-built `PluggedAdvancedFactory` (strict 3% cap, atomic name + ticker +
economics duplicate rejection, 1–4 equal-slice quote pools, up to 100 fee recipients) to the
Plugged runtime. Restart of thread 1566121184276381868, which stopped before writing files.
No commits, pushes, worktrees, mainnet broadcasts or ownership transfers were performed.
**No advanced factory is deployed; the runtime therefore reports advanced launch unavailable.**

## Files

- New: `lib/advanced-abi.mjs`, `lib/advanced-launch-service.mjs`, `web/advanced-launch.js`,
  `test/advanced-launch.test.mjs`, `test/advanced-launch-http.test.mjs`, this report.
- Edited (minimal, engine isolation and mounting): `lib/launch-store.mjs` (`list` filters by
  engine, default baseline), `lib/launch-service.mjs` (baseline `submit` refuses tagged records),
  `lib/trading-service.mjs` (token lookup excludes non-baseline records), `server.ts` (routes,
  reconciliation, readiness), `web/app.js` (`#advanced` route), `web/launch.js` (link),
  `web/i18n.js` (`advanced` title key, EN/ES).

## ABI

`advanced-abi.mjs` holds the human-readable factory/registry/token ABI. `loadAdvancedArtifacts()`
reads `contracts/out/PluggedAdvancedFactory.sol/PluggedAdvancedFactory.json` and
`PluggedLaunchRegistry.json`; every hand-written item must match the compiled selector, outputs,
mutability class and indexing. `encodeAdvancedLaunch()` encodes with both ABIs and refuses any
byte difference. A missing artifact disables advanced launch (fail closed). The portable package
must therefore ship those two compiled artifacts for the advanced path to activate.

## Service contract

`new AdvancedLaunchService({ store, client, profilePath, now, price, artifacts, loadProfile, verifyProfile })`.
`profilePath` defaults to `PLUGGED_ADVANCED_PROFILE`.

- `deployment(block)`: `loadDeploymentProfile` + `verifyDeploymentProfile` on **every**
  prepare and confirm. Missing profile, non-advanced engine or any verification error fails closed.
- `status()`: availability, capabilities, factory/registry, verified block; cached 30 s; never throws.
- `prepare(raw)`: inputs `account,name,symbol,imageCid,milestoneUsd,feeBps,creatorBps,markets[{quote,openingBuy}],recipients[{address,bps}],vestDays,cliffDays`.
  Unique catalog ERC-20 quotes sorted by address; decimals must match catalog, ERC-20 and pair
  registry; supply `10^27 − 10^27 mod n` (three pools mint one base unit less so slices divide);
  per-pool `openingMarketCap`/`graduationThreshold` = full-FDV quote value ÷ n (ceil), per the
  slice-supply rule in `workstreams/deployment.md`; opening buy between `minDevBuyFor` and 2% of
  its pool value; recipients unique, nonzero, total exactly 10,000 bps (empty only when creator
  share is 0; default 100% to the wallet); vesting 0 or ≥7 days with cliff ≤ vesting;
  `capToleranceBps` 200. On-chain: `economicsHash`, registry `canonicalName/Ticker`,
  `fingerprint`, `tokenFor` (duplicate refusal) and `predictTokenAddressFor(account,salt)`.
  Per-quote balance → `fund`; per-quote allowance → simulated approvals (nonzero reset to 0 first)
  → `approve`; otherwise simulated launch whose token must equal the prediction, gas +20% → `launch`.
  Factory custom errors are surfaced by name.
- `submit(id, txHash)` / `recordStatus(id)` / `confirm(record)`: exact sender, factory, calldata,
  zero value, chain 4663 and post-preparation block; canonical receipt block plus two blocks;
  exactly one `AdvancedLaunched`, one `Registered` and one `MarketOpened` per quote in sorted order;
  then at the receipt block `isOurs`, `poolsOf`, `pairsOf`, `tokenFor(key)`, `ledgerOf`, token
  canonical name/symbol, total supply and `MAX_WALLET_BPS == 300`. Profile addresses must equal
  those the record was prepared against.
- `reconcile()`: retries `submitted` advanced records (restart-safe; returns false on any failure).

Records carry `engine: 'plugged-advanced-v1'` and fingerprint `advanced:<registry key>` in the
shared `launches` SQLite table. Baseline listings, reconciliation, trading and rewards ignore them.

## HTTP

| Route | Gate |
|---|---|
| `GET /api/advanced/config` | none; returns `status()` |
| `POST /api/advanced/prepare` | `PLUGGED_LAUNCH_ENABLED` signing gate |
| `POST /api/advanced/submit` `{id,txHash}` | none (recovery) |
| `POST /api/advanced/status` `{id}` | none (recovery) |

Readiness adds `features.advanced` (`profileConfigured`, `verification:'per-request'`). The
worker reconciles advanced submissions after baseline and programs.

## UI

`#advanced` (linked from the Carbon launch page; nav highlights Create). EN/ES, light/dark,
same form grid and receipt rail. 1–4 quote rows, 0–100 recipient rows with live bps total,
vesting, per-quote approvals, launch, pending confirmation and hash recovery
(`plugged.pendingAdvanced`, `plugged.advancedRecoveryId`). When `/api/advanced/config` is
unavailable all inputs are disabled and the server reason is shown. Confirmed advanced tokens
are listed in Discover's "Advanced" section once re-verified (see "Advanced token integration").

## Verification — 2026-11-01

- `bun test test/advanced-launch.test.mjs test/advanced-launch-http.test.mjs`: **9 pass, 0 fail**.
- `bun test test/ tools/deployment.test.mjs`: **292 pass, 14 skip, 0 fail** across 26 files.
- `bun run build`: **294,294 JavaScript bytes**, no new dependencies.
- Chrome headless against a local `createPlatformServer` (port 4399, no profile): `#advanced` at
  390 px light EN and 1280 px dark ES rendered, no horizontal overflow, review disabled with the
  unavailable reason, **zero console/page errors**; `#create` shows the advanced link.
  Screenshots: `C:/Users/shies/AppData/Local/Temp/opencode/advanced-*.png`, `create-390-light-en.png`.
- Anvil end-to-end (`test/advanced-launch.integration.test.mjs`, new):
  `PLUGGED_ADVANCED_INTEGRATION=1 bun test test/advanced-launch.integration.test.mjs` →
  **6 pass, 0 fail, 55 expect() calls, 2.6 s**. Private `127.0.0.1` Anvil, `--chain-id 4663
  --hardfork cancun --code-size-limit 98304` (factory runtime is 29,016 bytes, over the 24,576
  EIP-170 default; same limit as `contracts/foundry.toml`). Production chain checks untouched.
  Setup: compiled `PoolManager` relocated to the canonical `POOL_MANAGER` address (its
  NoDelegateCall self-address immutable rewritten), `MockERC20` placed at catalog USDG (6 dec),
  cbBTC (8) and CRM (18); then the real advanced sequence from the deployer at nonces n..n+5:
  `PairRegistry`, `PluggedAdvancedToken`, `MultiDeployer`, CREATE2 `FeeHook` through the Anvil
  `0x4e59…` proxy with a JS-mined `0x20cc` salt, `PluggedAdvancedFactory`, `TradeRouter`. The
  profile is written with full CREATE/CREATE2 provenance and every role's code hash and is
  accepted by the unmodified `loadDeploymentProfile` + `verifyDeploymentProfile` on every call.
  Pair approvals are the unsigned transactions from `tools/deployment.mjs preparePairApprovals`.
  Covered: `status()` available; unfunded wallet → `fund`; 1-pool (USDG) and 3-pool
  (USDG/cbBTC/CRM, supply 10^27−1) launches through prepare → `approve` → approval txs →
  prepare → `launch` (simulated token = prediction) → send → `submit` (`submitted`) →
  `anvil_mine 2` → `recordStatus` → `confirmed`, cross-checked with `totalSupply`, `isOurs`,
  `pairsOf`; 2-pool launch then duplicate refusal (same input, and canonically equal
  `plugged duo`/`duo` from another wallet); foreign-sender submit of the prepared calldata
  rejected with no hash attached. Without the env var all 6 skip.
- `bun test test/advanced-launch.test.mjs test/advanced-launch-http.test.mjs
  test/advanced-launch.integration.test.mjs` (gate off): **9 pass, 8 skip, 0 fail**.
- No service or ABI bugs were exposed; `lib/advanced-launch-service.mjs` and
  `lib/advanced-abi.mjs` are unchanged by this pass.
- Policy observed (by contract design, not a bug): the registry key is canonical name +
  ticker + economics hash, so the same name/ticker with different economics (e.g. `feeBps` 300)
  prepares as a distinct launch. Names are canonicalised to upper case on chain (`PLUGGED SOLO`).
- Not run: AccessLint, live RPC/fork, or any public broadcast.

## Remaining gates

1. Deploy and verify a `plugged-advanced-v1` profile (`tools/deployment.mjs`), approve its pairs,
   then set `PLUGGED_ADVANCED_PROFILE`. Until then the path is unavailable by design.
2. ~~Anvil end-to-end prepare → approve → launch → confirm~~ closed on a private Anvil (above).
   Still open: a Robinhood mainnet *fork* run against the real canonical PoolManager code (the
   local run uses compiled v4-core relocated to that address) and confirmation that chain 4663
   accepts the 29 KB factory runtime.
3. Discover/token/trading/rewards integration is implemented and mock-tested (see below). Still
   open: holder basket-ledger claims, USD pricing/charts, browser pass, fork end-to-end trade.
4. Server error strings are English in the ES UI, matching the existing baseline behaviour.

## Advanced token integration

Closes the code side of remaining gate 3 (Discover, token page, per-pool trading, per-quote
rewards). Still inert in production: **no advanced profile is deployed**, so every route below
reports unavailable. Nothing was broadcast, committed or pushed. Tests use mocked RPC with the
real compiled ABIs only.

Files. New: `lib/advanced-market-abi.mjs`, `lib/advanced-market-service.mjs`,
`lib/advanced-trading-service.mjs`, `lib/advanced-rewards-service.mjs`, `web/advanced-markets.js`,
`test/advanced-markets.test.mjs`. Edited: `lib/trading-service.mjs` (router, pool id and engine
come from the snapshot; reviews are engine-scoped; baseline behaviour unchanged),
`lib/rewards-service.mjs` (baseline submit refuses engine-tagged preparations), `server.ts`
(routes, readiness), `web/trading.js` (optional `coin.pool` → advanced API, pool in the storage
key), `web/app.js` (Advanced Discover section, `#advanced-token/<address>`, Earnings section).

Verification model (fail closed):
- ABI: hook, TradeRouter, `PluggedAdvancedSplitter` and `PluggedAdvancedFeed` items must match
  `contracts/out` artifacts. A missing artifact or drift disables the whole thing.
- Listing and every trade/reward snapshot: verified profile (`deployment()`), record factory and
  registry equal to the profile's, then `AdvancedLaunchService.confirm` runs again on a copy (exact
  tx, events, canonical receipt, reads at the receipt block). After that, at one pinned block:
  `isOurs`/`poolsOf`/`pairsOf`; for each pool the key `{sorted currencies, fee 0, tickSpacing 60,
  profile FeeHook}` hashes to the confirmed pool id; hook `poolConfig` is configured with the same
  pair, fee and creator bps, and its creator is `splitterOf(token,pair)` (or `0xdEaD` when creator
  bps is 0); the feed's `hook`/`currency`/`ledger` match; quote decimals match the catalog.
- If any check fails, the token goes under `unavailable` with a reason and cannot be traded. With
  no profile, nothing is listed. Discover caches for 30 s and lists at most 50 tokens
  (`truncated` flag). Trading and rewards always re-verify with no cache.

Trading (real path, mocked here). Source review: `contracts/src/TradeRouter.sol` is a hook-agnostic,
exact-input, swap-first router. `swap(key, zeroForOne, amountIn, minOut, recipient)` works for any
v4 pool key. Advanced pools use the unchanged Carbon `FeeHook`. `AdvancedTradingService` reuses the
baseline review → approve → prepare → submit → replacement flow with a required `pool` field.
The router is the profile's `tradeRouter`, and both its manifest code hash and its live runtime
code hash must equal the pinned baseline `TRADING_ROUTER_HASH`. Its `poolManager` must be the
profile's. Approvals name that router. Submit requires exactly one `Traded` event whose key hashes
to the reviewed pool id. The token's 3% wallet cap makes over-cap buys revert in simulation.

Rewards (real path, mocked here), per quote pool: `sweep(key)` on the hook. A `FeeTaken` whose
creator or holder allocation is not matched by a hook `Transfer` reports `payment-deferred`.
`release(recipient)` on the splitter is limited to fixed beneficiaries: the `Released` event plus
an exact transfer. `recoverStuckFees()` works on the splitter (creator share) and on the feed
(holder share), with amounts from `stuckFeesOf(currency, target)`; it needs a `StuckFeesRecovered`
event plus a hook→target transfer of the same amount. A splitter is trusted only if it has code
and its currency equals the pair, `hook` equals the profile FeeHook, `planHash` equals the
confirmed economics hash, and every `recipients(i)`/`sharesBps` matches the record. Positions are
capped at 25 tokens. Signing (`prepare`) uses the same `PLUGGED_LAUNCH_ENABLED` gate as baseline.

Routes: `GET /api/advanced/markets`, `GET /api/advanced/token?address=`,
`POST /api/advanced/trading/{balances,quote,prepare*,submit,status}`,
`POST /api/advanced/rewards/{positions,prepare*,submit}` (* = signing gate). Readiness
`features.advanced` adds `markets`, `trading:'per-pool'`, the reward actions and
`holderLedgerClaims:false`.

UI: Discover shows a separate "Advanced" section under the baseline grid. Cards are tagged
Advanced, list their quote pools, and say no price/volume index is connected. The token page has
a per-pool table (hook quote market cap, milestone progress, fee, pool id) and a radio pool
selector that drives the shared trade panel. Earnings has an "Advanced launch rewards" section
with per-pool actions and pending-hash recovery. EN/ES strings are inline.

Verification — 2026-11-01:
- `bun test test/advanced-markets.test.mjs`: **10 pass, 0 fail**.
- `bun test test/`: **294 pass, 24 skip, 0 fail, 318 tests across 27 files**. One earlier full run
  had 1 failure in `test/media.test.mjs`, which is not in this change; it passes alone (13/13) and
  on the rerun.
- `bun run build`: **326,798 JavaScript bytes**, no new dependencies.
- Not run: browser/screenshot pass of the new UI, AccessLint, Anvil/fork trade or claim through a
  real advanced deployment, live RPC.

Unavailable / unfinished:
1. Holder-share claims from the advanced basket ledger (`PluggedAdvancedLedger`) are not
   integrated. The UI and API say so (`holder.status:'unavailable'`).
2. No USD price, volume or chart index for advanced pools. Only hook quote-denominated market cap.
3. A profile whose router bytecode differs from the pinned Carbon router stays read-only (trade
   refused) until it is reviewed and pinned.
4. Fork end-to-end launch → trade → sweep → recover against a real advanced deployment.

## Known limits (audit 2026-11-02)

- **L-1 vest release and the 3% wallet cap.** Vesting uses Carbon's `MultiVestingVault`, whose
  `release()` sends the whole vested amount. If anyone transfers tokens to the beneficiary so that
  balance + vested amount exceeds the 3% cap, `release()` reverts until the beneficiary moves tokens
  out. Partial release would need a change in Carbon's vault, not Plugged code, so this is documented
  and shown on the Advanced launch page instead of fixed.
- **L-2 recipient cap.** `MAX_RECIPIENTS` is 50 (was 100). Measured worst case, 4 markets x 50
  recipients: 19,585,230 gas in `forge test --match-contract AdvancedGasRegression` (was 29.9M at
  4 x 100), well under the ~32M Nitro block limit. Not yet measured on chain 4663 itself.
- **L-3 duplicate registry.** The registry rejects only exact duplicates of name, ticker and
  economics. Recipients are not part of the identity, so a leaked config can be launched first by
  someone else with their own recipients, and a 1-wei economics change counts as a new launch.
  Treat a launch as yours only when its confirmed recipients are yours.
