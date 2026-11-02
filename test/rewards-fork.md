# Deployed Carbon rewards fork verification

Executed result: **4 passed, 0 failed, 0 skipped** on Robinhood Chain 4663, block
**102763698**, hash `0x0927ade8b58e12ba6d2be4a08c271bbcd4d6400f0b38a225da99c50ae37a5b49`.
Exact measured amounts and ABI facts are in `rewards-fork-results.json`.

## Replay

From the repository root:

```powershell
node plugged/test/rewards-fork-run.mjs 102763698
```

The runner creates an isolated Foundry project under `%LOCALAPPDATA%/Temp/opencode`.
It imports only the installed `forge-std`; it does not compile local Carbon contracts.
Compiler: Solidity 0.8.26, Cancun, optimizer 200 runs, via IR.
Foundry: 1.5.1-stable. This machine's WSL `forge` is a shell shim to
`C:/Users/shies/.foundry/bin/forge.exe`, so the runner calls that same binary directly
with Windows paths. Override with `REWARDS_FORGE` if needed.

The public RPC prunes historical state: the original fixture block **102239693**
and the first probe block **102728808** failed with `historical state ... is not available`.
Exact replay therefore needs retained Foundry RPC cache or an archive-capable
`PLUGGED_RPC_URL`. To deliberately verify a new snapshot instead:

```powershell
node plugged/test/rewards-fork-run.mjs --fresh-pin
```

This prints the selected block and hash before execution; the Solidity fork still
uses that explicit block number. It does not silently fall back on replay failure.
Every run writes full Foundry output to the printed temporary project's `run.log`.
The successful original run is at
`C:/Users/shies/AppData/Local/Temp/opencode/carbon-rewards-fork-0lHnup/run.log`.
Exact pinned replay also passed all four tests with identical amounts; its output is
`C:/Users/shies/AppData/Local/Temp/opencode/carbon-rewards-fork-T2J6eD/run.log`.

## What executes

- Assert the deployed launcher, hook, and trade-router code hashes against the supplied deployment record.
- Launch real deployed Carbon tokens on the local fork using fixture calldata, changing
  `creatorBps` to 5000, `sellFeeBps` to 400, fee recipient to a separate address, and
  automatic-push threshold to `uint256.max` so explicit holder withdrawal is exercised.
- Seed only the holder's pair-token balance with Foundry `deal`; impersonate callers
  and advance local time. No Carbon runtime is replaced, no claimable balance is fabricated,
  and no transaction is broadcast.
- Execute initial dev buy plus a deployed-router buy for USDG and WETH.
- Sweep as a third-party address; check creator payment, distributor funding, platform
  payment, bounty, exact conservation of redeemed fees, and zero pending fees.
- Verify zero immediate holder claim, the deployed 86400-second stream window, then
  advance to stream completion and execute `withdraw()`.
- Check actual pair balance gain, per-holder and total withdrawal accounting, zero remaining
  claimable amount, at most two base units of rounding dust, and rejection of a duplicate claim.
- Separately launch with a nonzero opening window and fee to verify all 14 positional
  `poolConfig` outputs, including `openingFeeEndsAt`, `openingWindow`, and `openingFeeBps`.

## Live ABI findings

`poolConfig(bytes32)` returns **448 bytes / 14 words**. The first ten outputs match the
older UI ABI. Zero-based indices **10–13** are `uint32 openingFeeEndsAt`,
`uint32 openingWindow`, `uint16 openingFeeBps`, `address rewardCurrency`.
The older 11-output declaration reads the opening-end timestamp as the reward address.
ABI integer widths/names are taken from the matching source layout; returned word count,
field positions and configured values are verified through deployed bytecode execution.

`claimStuckFees(address)`, `stuckFeesOf(address,address)`, `stuckFees(address,address)`,
and `stuckTotal(address)` are absent from the deployed runtime selector table and all
revert with empty return data. A successful deferred creator claim cannot be tested
against this deployment: it does not expose that functionality. The test records this
deployment capability limit rather than claiming deferred-payout success.

This is a targeted buy-fee rewards verification, not sell-fee conversion or failed-transfer
recovery coverage. Only USDG and WETH reward payouts were exercised.
