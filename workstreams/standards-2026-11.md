# Robinhood Chain (4663) and Uniswap v4 standards review — 2026-11-03

Scope: does Plugged's backend and contract code match the platform as it runs today?
Every claim is labelled **measured** (read from chain 4663 by `tools/rh-chain-probe.mjs` or a
one-off RPC probe on 2026-11-03, block ~105.34M), **sourced** (primary doc, URL given) or
**inferred** (reasoning, not tested). Re-run `bun tools/rh-chain-probe.mjs` before any deployment;
it exits 1 if a pinned code hash, the chain id, the code-size limit or a required opcode changes.

Sources (8 fetches):
- ArbOS releases overview — https://docs.arbitrum.io/run-a-node/arbos-releases/overview
- ArbOS 61 Elara — https://docs.arbitrum.io/run-a-node/arbos-releases/arbos61
- Uniswap v4 deployments — https://docs.uniswap.org/contracts/v4/deployments
- Robinhood Chain about — https://docs.robinhood.com/chain
- Differences from Ethereum — https://docs.robinhood.com/chain/differences-from-ethereum
- Building with Stock Tokens — https://docs.robinhood.com/chain/building-with-stock-tokens
- Oracles & Price Feeds — https://docs.robinhood.com/chain/oracles-and-price-feeds
- v4-core security page — https://github.com/Uniswap/v4-core/security ("There aren't any published security advisories")

## 1. Chain platform, EVM target and compiler

| Item | Value | Basis |
|---|---|---|
| Chain id | 4663 | measured |
| ArbOS | **61 (Elara)** — `ArbSys.arbOSVersion()` = 116 (−55), same in block `mixHash` | measured; release notes sourced |
| Opcodes | PUSH0, TSTORE/TLOAD, MCOPY live; **CLZ (Osaka/EIP-7939) also live**; BLOBBASEFEE rejected ("not supported on Arbitrum") | measured via `eth_call` state override |
| Prague precompiles | BLS12-381 at `0x0b` present ("invalid input length"); P-256 at `0x100` present | measured |
| EIP-7702 | `eth_estimateGas` accepts a type-4 tx with an authorization list (46,466 gas) | measured (estimate only, nothing sent) |
| Max contract code | **98,304 bytes** (98,305 rejected: "max code size exceeded") | measured; doc says 96 KB code / 192 KB init |
| Per-tx gas | `ArbGasInfo.getGasAccountingParams()` → speed limit 7,000,000/s, pool max 32,000,000, **max tx gas 32,000,000**; a 20.2M-gas call estimates fine | measured |
| Block gas limit field | 1,125,899,906,842,624 (Nitro placeholder, not a real cap) | measured |
| Ordering | first-come-first-served; priority fees do not reorder | sourced (RH differences). ArbOS 61 adds optional tip collection; not observable as enabled on 4663 |
| Screening | sequencer drops sanctioned-address txs; reads unaffected | sourced |
| `block.number` | L1 estimate; use `ArbSys.arbBlockNumber()` | sourced |

**Our code:** `contracts/foundry.toml` pins `solc_version = "0.8.26"`, `evm_version = "cancun"`,
`code_size_limit = 98304`, `bytecode_hash = "none"`, `cbor_metadata = false`. No contract in
`contracts/src` reads `block.number`, `prevrandao` or `blockhash` (grep, 2026-11-03).

**Gap / decision:** none blocking. The chain now accepts Prague and even Osaka opcodes, so
`cancun` is a strict, safe subset. Moving to `prague`/`osaka` or a newer solc would change every
bytecode hash, force a hook-address re-mine and invalidate the 100/100 forge evidence and the audit
fixes for **no functional gain** (nothing in our code needs CLZ, BLS or 7702). **Recommendation:
keep 0.8.26 + cancun for this release** (inferred, low risk). Revisit only with a new audit.
The 96 KB limit is a Robinhood Chain setting; Arbitrum One keeps 24 KB for Solidity (sourced,
ArbOS 61 notes) — the advanced factory therefore cannot be redeployed unchanged on Arbitrum One.

**L-2 follow-up:** our 4 markets × 50 recipients launch measured 19,585,230 gas on Anvil. It is
under the measured 32,000,000 max tx gas (61% of the cap). A loop costing 20.18M gas estimates on
4663 (measured). A full fork run was not possible: see section 5.

## 2. Uniswap v4 deployment and hook standards

Uniswap's official table for "Robinhood Chain: 4663" (sourced) matches every pinned address, and
`tools/rh-chain-probe.mjs` pins size + keccak code hash for each (measured):

| Contract | Address | Bytes | In our code |
|---|---|---|---|
| PoolManager | `0x8366a39C…40951` | 24,009 | `lib/deployment-profile.mjs:7`, `contracts/script/DeployPlugged*.s.sol:16` |
| PositionManager | `0x58daec31…04fa7` | 23,877 | not used |
| V4Quoter | `0x8dc178ef…98f94` | 6,118 | not used |
| StateView | `0xf3334192…e673b` | 3,531 | **new**: `lib/onchain-price.mjs` (M2 reference) |
| UniversalRouter | `0x88767899…c0904` | 24,546 | not used |
| UniversalRouter 2.1.2 | `0x204FAca1…10498` | 24,380 | listed by Uniswap, not used (info only) |
| ReservesLens | `0x0000001b…4865B` | 14,142 | listed by Uniswap, not used (info only) |
| Permit2 | `0x00000000…78BA3` | 9,152 | not used (see 4) |
| CREATE2 deployer | `0x4e59b448…4956C` | 69 | deploy scripts, `lib/deployment-profile.mjs:6` |

Library versions in `../contracts/lib` (measured with git): v4-core `v4.0.0-12-g59d3ecf5`
(2025-05-13), v4-periphery `07336f2` (2026-08-10), OpenZeppelin 5.7.0, forge-std 1.16.2+.
v4-core has no published security advisories (sourced). Hook permission bits are unchanged in the
vendored `Hooks.sol`; the Carbon FeeHook is mined for `0x20cc` (beforeInitialize, beforeSwap,
afterSwap, beforeSwapReturnsDelta, afterSwapReturnsDelta) and the advanced factory checks
`hook.poolManager()` (`contracts/src/PluggedAdvancedFactory.sol:153`).

**Gap:** none on addresses or hook flags. The new UniversalRouter 2.1.2 is only relevant if we route
through Uniswap's router; we do not.

## 3. Robinhood-specific standards

| Topic | Platform (sourced) | Our state | Gap / action |
|---|---|---|---|
| Stock tokens | Plain ERC-20, 18 decimals, freely transferable; ERC-8056 `uiMultiplier()`, `balanceOfUI`, `TransferWithScaledUI`; not rebasing | Quote assets come from the pair registry snapshot; amounts handled raw | Raw handling is correct. **Recommended (not done):** show `balanceOfUI` "share equivalent" next to stock balances. Low value for launch. |
| Transfer restrictions | None at token level; sequencer screening of sanctioned addresses only | No assumptions made | none |
| Price feeds | Chainlink per stock + crypto; sequencer-uptime feed recommended; stock feeds 24/5; `oraclePaused()` advisory | No Chainlink reads; USD price from LI.FI | M2 now uses the v4 ETH/USDG pool (section 5). **Recommended (not done):** Chainlink stock-feed cross-check — feed addresses live only on Chainlink's JS page, which we did not verify; never hardcode unverified feeds. |
| Token list | `Token Contracts` page generated from on-chain asset registry | Pair registry snapshot (31 approved / 438 pending) | none; ticker impostors make address allowlists mandatory, which we already do |
| Finality | Soft confirmation from sequencer; hard finality after L1 posting | Services treat a receipt at canonical depth (2 extra blocks) as final | Acceptable for a UI; document that this is soft finality (done in HANDOFF). |
| RPC | Alchemy recommended; public RPC rate limited | `PLUGGED_RPC_URL` env with public default, batching, 20s timeout | Set an Alchemy URL in production (documented). |
| Account abstraction | ERC-4337 first-class | Not used | none required |

## 4. Wallet standards

| Standard | Our state (file:line) | Gap | Decision |
|---|---|---|---|
| EIP-1193 provider | All flows use `provider.request` and listen to `accountsChanged`/`chainChanged` (`web/app.js:320`) | none | — |
| EIP-6963 discovery | Implemented (`web/app.js:60-64`), legacy `window.ethereum` fallback (`web/app.js:305`) | none | — |
| Chain binding | Every send re-reads `eth_chainId` == 4663 (`web/trading.js:83`, `web/launch.js:68`, …); server rejects `tx.chainId !== 4663` | none | — |
| EIP-5792 `wallet_sendCalls` | Not used; approve and trade are separate reviewed txs (`web/trading.js:129`) | Two prompts for ERC-20 sells | **Deferred (not low risk).** The server binds each preparation to one tx hash and verifies its receipt; a batch returns a bundle id, the trade cannot be simulated before the approval exists, and wallet support varies. Doing it properly needs a server batch-preparation type plus `wallet_getCallsStatus` reconciliation. |
| Permit2 / EIP-2612 | Not used | Extra approval tx | **Not possible without new contracts.** The deployed Carbon `TradeRouter` pulls with `transferFrom`; it has no Permit2 path. Applies to the next engine only. |
| EIP-712 | Used for cashback vouchers (`lib/cashback-index.mjs`) with domain chain id | none | — |
| ERC-7201 storage | No upgradeable/proxy contracts in `contracts/src` | not applicable | — |

## 5. Changes made in this pass

1. **`tools/rh-chain-probe.mjs`** (new): read-only probe for chain id, ArbOS, opcodes, max code size,
   max tx gas and code hashes of all pinned contracts. Run result 2026-11-03: all match.
2. **Audit M2 cross-check** (`lib/onchain-price.mjs`, `lib/funding-service.mjs`, `lib/market-services.mjs`):
   - Reference = hookless native ETH/USDG 0.05% v4 pool (`0x387bf619…25982`, the deepest of six tiers
     measured; liquidity 1.52e17) read through StateView. Thin pool (<1e15 liquidity) fails closed.
   - ETH funding: LI.FI expected output must be within **5%** of the pool price (USDG) or 1:1 (WETH),
     otherwise preparation is refused. Other quote assets have no on-chain reference and keep the
     1.5x jump guard plus 10 ETH cap.
   - ETH/WETH USD valuation: LI.FI ETH price must be within **10%** of pool price × LI.FI's USDG price.
     It catches one bad provider price, not both prices wrong together (stated in code).
   - A spot pool can be moved within a transaction; here a moved pool can only cause a refusal,
     never a worse fill, because the user's minimum output still comes from the checked route.
   - Live check 2026-11-03: pool 2,288.89 USDG/ETH vs LI.FI $2,288.89 (measured).
3. No compiler, EVM target, address or deployed-contract change was needed.

L-2 on a 4663 fork: not run. Anvil forking of the public RPC for a full advanced deployment would
replay thousands of state reads against a rate-limited endpoint on a host that recently ran out of
memory; the per-tx cap (32M) and a 20.18M estimate were measured instead. Treat the 19.6M figure as
Anvil-measured, chain-cap-checked, not chain-measured.
