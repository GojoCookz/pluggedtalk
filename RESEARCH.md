# Plugged research and reuse map

Checked 2026-10-30; social/valuation evidence updated 2026-10-31 UTC. The private chat itself is not copied into this project; PRODUCT.md
records only requirements and message IDs.

## Reference behavior

- https://docs.bags.fm/how-to-guides/launch-token.md — metadata, image/social links,
  launch with optional initial buy, fee shares up to 100 recipients, 10,000 BPS allocation,
  GitHub/Twitter/Kick claimers, partner configuration, supported custom quote configurations.
  The guide describes a 25% config-payer reservation on new SOL v2 gross claimers pools;
  recipient percentages are not percentages of total trading volume.
- https://docs.bags.fm/ — authenticated SDK/API with both Solana and Robinhood EVM
  documentation. See https://docs.bags.fm/robinhood/launch-token.md and
  https://docs.bags.fm/robinhood/claim-fees.md; version-specific fee rules differ.
- https://docs.robinhood.com/chain — EVM/Arbitrum chain, ETH gas, first-come sequencing.
- https://docs.uniswap.org/contracts/v4/deployments#robinhood-chain-4663 — chain 4663,
  PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`. Deployment docs are not
  a current bytecode attestation. Runtime checks independently verify the read source.

The bounded research pass does not establish exhaustive Bags parity. Further inventory must
cover claim authentication, transfer of fee rights, trading, search, creator pages,
analytics, referrals, API/SDK, moderation, and current consumer-facing features.

## Parity roadmap

| Surface | Foundation in this build | Remaining integration |
|---|---|---|
| Discovery | Plugged-only undeployed empty market; separate quote catalog | Dedicated Plugged deployment/indexer; full-universe trending |
| Launch | Validated draft, metadata/socials, quote choice, 3% proposed cap, recipient allocation, JSON export | IPFS pinning, fresh launcher, simulation, approvals, submission and receipt reconciliation |
| Trading | Market details, conditional chart, validated ETH → quote funding preview | Atomic ETH → launch-token router, execution-time min-out/deadline, receipts |
| Fees | Immutable split contract, per-token claim accounting and fee-share preview | Hook fee-recipient wiring, deployment, claim UI and indexing |
| Community rewards | Holder share recorded separately in draft | Existing streamed MultiRewardDistributor integration and keeper |
| Social recipients | Wallet/X/GitHub allocations, Bags EVM resolver, signed identity-bound receipts | Live resolver test, provider-approved owner onboarding and wallet access, claim UI |
| Referrals | Explicitly declined by Merc | No program or legacy vault integration |
| Fundraising/cashback/refunds | Validated drafts and undeployed escrow/voucher contracts | Funding and claim UI, trusted eligible-fee attestor, deployment |
| API/SDK | Read endpoints, validated plan endpoint | Authenticated publishing, quotas, SDK and documentation |
| Themes/language | Persistent light/dark and English/Spanish | Translator-reviewed additional locales |

## Reuse, not blind cloning

| Existing source | Reuse and exact limitation |
|---|---|
| `app/src/lib/abi.ts` | Registry read ABI reference only; no Carbon launch-list fetching |
| `app/src/lib/networks.ts:382–397` | Provenance for legacy read-only launcher, registry and crypto quote addresses; runtime checks still required |
| `contracts/src/LaunchToken.sol:201–217` | Holding-cap pattern catches inbound wallet transfers, preserves sales to pool; **launcher-origin exemption means creator can exceed 3%** |
| `contracts/src/Launcher.sol:98,185–234` | Atomic launch, metadata, feeRecipient insertion point for our split contract; existing max unvested dev buy is 10%, not Plugged's 3% |
| `contracts/src/FeeHook.sol` | Currency-aware fees, deferred ERC-6909 claims, fixed platform-volume cut; inspect exact deployed version before integration |
| `contracts/src/MultiRewardDistributor.sol` | Streamed holder rewards and precision protections; immutable collaborators should not be modeled as transient token holders |
| `contracts/src/TradeRouter.sol` | Swap first; contiguous sync/transfer/settle; validate credited amounts |
| `contracts/src/PairRegistry.sol` | Explicit token-address eligibility; “any coin” needs onboarding, not ticker trust |
| `contracts/src/ReferralVault.sol` | Not integrated: Merc declined referrals |
| `contracts/docs/EVM-LAUNCHPAD-PLAYBOOK.md` | Settlement ordering, reward streaming, single-sided opening economics, deployment choreography |
| `app/server/chatHandler.ts`, `profileHandler.ts` | Later signed community/profile integration; avoid anonymous write paths |

## Stack decision

Static HTML/CSS and browser modules, Bun build/runtime already installed, existing workspace
viem for ABI encoding and Ethereum addresses. No new React app, dependency installation,
or duplicated node_modules. Contract tests use existing Foundry/OpenZeppelin/forge-std.
Public server serves only the frozen `dist/` allowlist, never the repo or chat export.

## Design plan

The brief pins the visual direction: a white/green, iOS-clear market board with early pump
simplicity. This overrides the concept-seed alternatives (key `5ca6d675`). Restrained white
surface `#ffffff`, cool canvas `#f5f7f6`, ink `#14241c`, green `#087b46`, secondary ink
`#56665d`, mint `#e7f6ed`. Native rounded system display, system body, tabular monospace
for addresses only. Compact market feed first, creator fee allocation as the signature
interactive detail. Mobile bottom navigation, desktop top navigation. No promotional
hero, fabricated tokens, market-cap counters, or decorative sparklines.

The default crypto dashboard would put stats and an oversized chart ahead of the coins.
This plan instead puts source selection and searchable coins first, with fees explained
in a small side panel. Saved drafts never mix with live markets.

## Pons economics: measured reference, not pools.trade

Official sources: https://www.ponsfamily.com/launchpad,
https://docs.ponsfamily.com/docs and https://docs.ponsfamily.com/docs/v2.
The old workspace note `contracts/audit/15-pons-reference.md` conflates Pons with
pools.trade; its attribution is not adopted here.

`data/pons-reference.json` preserves retained live reads at blocks 102120191 (factory),
102120668 (hook and asset economics) and 102122189 (example curve), with source and
collection caveats. The times are block timestamps, not retrieval wall-clock times.
85 of 469 catalog candidates were approved: 78 issuer stocks/ETFs and 7 others, plus
native ETH as a separate path. This is not exhaustive allowlist or bridge enumeration.

- Pons V1: immediate Uniswap V3, WETH-only, graduation is a principal milestone without migration.
- Pons V2: separate constant-product curve, then locked Uniswap V4. Direct V4 remains an
  explicitly separate Plugged architecture choice, not a claim about Pons V2.
- Observed launch fee: 0.0005 ETH; supply: one billion; base fee: 1% both directions;
  protocol: 30% of base fees, equivalent to 0.30% of volume before integer rounding;
  immutable creator surcharge: 0–10%. Core LP fee: zero; tick spacing: 200.
- Native opening FDV/phantom reserve: 1.68 ETH; net real-quote graduation target: 4.2 ETH;
  derived idealized terminal curve FDV: 20.58 ETH. These are three different quantities.
- Opening setting: 9900 BPS for 3 seconds, capped to leave 1% for the curve. Combined fees
  may reach 99%. Docs' five-second/public-launch-closed claims disagree with live reads.
- Buybacks allocate 50% of the creator's remaining base-fee share; bought tokens vest over
  five years rather than burn. Holder dividends and hybrid pools are Plugged extensions.
- Output math floors; inverse input math adds an unconditional one. Final buys may partly
  fill and refund. Graduation progress uses real quote reserve / threshold, not tokens sold.
- Pre-graduation reserves include phantom quote and exclude accrued fees. After graduation,
  hook fee currency follows the unspecified swap currency; curve arithmetic is not a V4 quote.

Fresh verified-source downloads returned 403 (explorers) / 404 (old GitHub URL). Exact
V4 fee-rounding parity, graduation seeding, tax-decay implementation and source-to-bytecode
verification remain unresolved. Reference arithmetic is not transaction-grade parity.

## Why $40,000 is a product milestone, not a Pons constant

Retained USDG observations at block 102120668: phantom quote/opening FDV **3,236 USDG**,
net real-quote target **8,090 USDG**. Continuous-model terminal FDV is:

```text
(3,236 + 8,090)^2 / 3,236 = 39,641 USDG
terminal / opening = 12.25
```

This equals $39,641 only if USDG is exactly $1. Integer rounding and execution history
can change the marginal terminal value. Bitquery documents 4/49 excess supply permanently
locked; excluding it gives `39,641 × 45/49 = 36,405 USDG`. That is a possible explanation
for the remembered $36k/$40k figures, **not verified Pons frontend market-cap behavior**.
Source: https://docs.bitquery.io/docs/blockchain/robinhood/pons-api/#the-supply-split

Keeping the 12.25× multiplier with a $2,500 opening would give **$30,625**, not $40,000.
Plugged therefore explicitly chooses a $40,000 full-supply USD milestone. Direct V4 does
not inherit the reserve curve formula. Pons V1 documents `graduationStatus(token)` with
principal/threshold/graduated fields and no migration. No universal direct-V4 terminal
submission interface was established. External recognition needs protocol-specific indexing.

## Bags social allocations: Solana versus Robinhood EVM

Official sources checked:

- https://docs.bags.fm/api-reference/get-fee-share-wallet.md
- https://docs.bags.fm/api-reference/openapi.json
- https://docs.bags.fm/robinhood/launch-token.md
- https://docs.bags.fm/robinhood/claim-fees.md
- https://docs.bags.fm/how-to-guides/launch-token.md
- https://docs.bags.fm/how-to-guides/claim-fees.md
- https://docs.bags.fm/faq/linking-wallets.md

The resolver defaults to Solana; Plugged explicitly sends `chain=EVM`, with provider
`twitter` or `github`, username and server-only `x-api-key`. Response must match provider,
normalized handle, `platformData.id`, EVM chain and nonzero wallet. Missing EVM wallets may
be created through Privy. No live call was made without a configured key.

Solana `/fee-share/config` uses base58 `claimersArray` and `basisPointsArray`; its SOL-v2
deployer reservation is separate from recipient BPS. Claims use `/token-launch/claim-txs/v3`.
Robinhood's factory uses aligned EVM `claimers[]`/`bps[]`; EVM discovery and transaction
construction use `/evm/rh/claimable-positions` and `/evm/rh/create-claim-txs`. An API key
does not sign those transactions. Fee versions, mutable Bags rosters and quote decimals
must be handled explicitly; Solana SDK transactions cannot be reused on EVM.

The public API does not document a Plugged OAuth callback that unlocks a Bags-created
wallet, cross-app Privy wallet adoption, or guaranteed never-joined-profile provisioning.
Wallet-export guidance inspected is Solana-oriented. These remain unverified rather than
being inferred from the phrase “embedded wallet.” Required acceptance test: a controlled
never-joined X/GitHub profile resolves, receives fees, then its rightful owner gains access
to that exact EVM wallet and can use the funds. Bags claim indexing does not cover Plugged
contracts; Plugged needs its own claim reads and UI.

## USD prices and ETH funding: live evidence and execution boundary

Read-only probe at **2026-10-31T00:44:32.575Z** returned:

| Asset | Provider USD estimate | Quote units for $2,500 opening |
|---|---:|---:|
| Native ETH | 2244 | 1.114081996434937612 |
| USDG | 0.9985862729 | 2503.539322 |
| AAPL | 345.5818142773 | 7.234176963935847411 |

The same run quoted **0.001 ETH → 2.239253 USDG**, minimum **2.228057 USDG**, provider
`sushiswap`, requested slippage 50 BPS. These are timestamped estimates, not promised
execution prices. Raw evidence: ignored `artifacts/integration-check.json`.

Source: https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer

The service validates chain, asset, decimals, account, input, output, transaction value and
minimum-output bound. Provider calldata remains server-side and `executable` is false.
The probe predates the final strict ceiling-rounding change; that change is covered by
unit tests, not a second live quote. Retrieval time is not the underlying price timestamp.
Execution must obtain fresh prices/routes, simulate and enforce final launch-token output.
“ETH” here is native Robinhood ETH, not an implemented bridge from Ethereum L1. The catalog's
bridged WETH is not assumed to expose a native `deposit()` wrapper.
