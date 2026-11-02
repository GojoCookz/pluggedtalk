# Carbon and Bags reference inventory

Researched 2026-10-30. These are source observations, not claims that every reference
feature is currently operating in production. No Carbon launch tokens are imported into
Plugged discovery. Quote-address research is separate from launch listings.

## Carbon feature map

| Surface | Source observed | Plugged disposition |
|---|---|---|
| Board search, sorting, multi/new filters, sponsored/upcoming sections | `app/src/pages/Board.tsx:24–84` | Plugged-only empty market until deployment; no borrowed launch list |
| Trade terminal, charts, fee sweeping, promotions | `app/src/pages/Token.tsx:48–61` | Transaction integration pending |
| Trades, rewards, disclosures, token chat | `app/src/components/token/TokenDataTabs.tsx:22–64` | Pending token deployment/indexing |
| Name, symbol, square image, optional banner, saved draft | `app/src/components/creation/CarbonCreation.tsx:197–218` | Identity and drafts implemented; media publishing pending |
| Launch website, X and GitHub | `app/src/components/creation/SocialFields.tsx:28–40` | Implemented in Plugged drafts |
| Profile Telegram, Discord, YouTube, website, GitHub, X | `app/src/lib/profile/socials.ts:4–49` | Added to Plugged project links; Farcaster also supported. No implied identity verification |
| Signed token metadata/pinning | `app/src/lib/tokenInfo.ts:3–36`, `app/server/pin.ts:101` | Draft export only; publication pending |
| Up to four markets, opening buys/valuation, locked liquidity | `CarbonCreation.tsx:223–259` | Quote catalog and 2–4 independent-pool hybrid drafts; execution pending |
| Holder percentage, advanced fees, burn/buyback, fee wallet | `CarbonCreation.tsx:397–422`, `Tokenomics.tsx:12–24` | Developer/community toggles and complementary ratios implemented; burn/buyback pending |
| Reward conversion and independent quote balances | `Tokenomics.tsx:55–101` | Native quote planning; live converter pending |
| Vesting, opening-fee decay, wallet cap | `CarbonCreation.tsx:365–376` | Strict 3% policy still needs a new launch-token integration; legacy exemptions are not copied as guarantees |
| Holder claims and bounded batch payments | `docs/community-rewards-release.md:5–18`, `docs/rewards-operations.md:5–17` | Holder integration pending; immutable collaborator splitter built |
| Scheduled rewards and volume tasks | `docs/rewards-operations.md:51–69` | Source documents disabled scheduling; not described as unattended live service |
| Referral codes and currency-specific legacy claims | `docs/custom-referral-codes.md`, `app/src/lib/referralPayoutPolicy.ts:28–50` | Explicitly excluded: Merc declined referrals |
| Profile proof and signed saves | `app/src/components/profile/SocialsEditor.tsx:124–132` | Social URLs are metadata only; payout-identity proof pending |
| Check-ins, badges, streaks, cosmetics, rankings | `docs/cosmetics-achievements-leaderboards.md:14–83` | Separate future participation layer |
| Upcoming launches, subscriptions, calendar | `app/src/pages/Soon.tsx:11,174,218` | Pending |
| Telegram reminders/trending/placements | `docs/telegram-bot.md:5–75` | Operational configuration required; pending |
| Launchpad Studio | `app/server/launchpadHandler.ts:1–11`, `app/src/lib/launchpad/service.ts:92–113` | Signed request configurator, not automated deployment |
| Network selection | `app/src/lib/activeNetwork.ts:157` | Plugged remains Robinhood 4663 |

## Bags API study

Current documentation includes **Robinhood EVM**, not just Solana. The initial research
pass missed this; it is corrected here and in the interface.

### Metadata and socials

`POST https://public-api-v2.bags.fm/api/v1/token-launch/create-token-info` uses multipart
data with `name`, `symbol`, `description`, optional `telegram`, `twitter`, `website`, and
image/image-URL/metadata-URL combinations. GitHub recipients are a separate identity flow,
not a repository field that grants ownership.

Source: https://docs.bags.fm/api-reference/create-token-info.md

### Social beneficiaries

`GET /token-launch/fee-share/wallet/v2?provider=github&username=HANDLE&chain=EVM` resolves
provider identities to an EVM wallet. Requests use `x-api-key`. The endpoint may create an
embedded wallet; it is not a read-only registry lookup. Plugged calls it only after an
explicit resolution action, with a server API key. Both `provider=twitter` and `provider=github`
use `chain=EVM`. Signed, expiring receipts bind provider ID, normalized username and wallet;
launch preparation rejects altered, expired or duplicate resolved wallets. Live resolution
has not been tested: the key is absent. A GitHub username is not a repository ownership claim.

Source: https://docs.bags.fm/api-reference/get-fee-share-wallet.md

### Recipient allocations and claims

The Solana configuration endpoint accepts `claimersArray` and `basisPointsArray`, with
1–100 recipients totaling 10,000 BPS. Its separate SOL-v2 deployer reservation must not be
misapplied to EVM economics.

Source: https://docs.bags.fm/api-reference/create-fee-share-configuration.md

The Robinhood guide describes factory `create(...)` / `createAndBuy(...)`, aligned
`claimers[]` / `bps[]`, unique nonzero recipients, a live creation fee read and receipt
parsing. The inspected WETH claim guide describes 2% total trading fees: 1% of volume for
creators and 1% for protocol; partner share comes from the protocol half. It distinguishes
unswept pending fees from notified claimable balances. `claim(true)` unwraps WETH; false
retains it. `setClaimers` can modify recipients under the fee-share owner; these Bags splits
must not be described as universally immutable. Plugged's current splitter is immutable.

- https://docs.bags.fm/robinhood/launch-token.md
- https://docs.bags.fm/robinhood/claim-fees.md
- https://docs.bags.fm/llms.txt

The documentation index lists multiple deployment versions and custom-quote variants.
Inspect the exact chosen factory/version before adopting rates, ownership or ABIs. This
build does not silently route fees through Bags or reuse its contract addresses.

The EVM API exposes `GET /evm/rh/claimable-positions?owner=0x...` and
`POST /evm/rh/create-claim-txs` with `{tokenAddress, owner}`. Returned transactions must be
signed by that owner and executed in order. Custom-quote raw amounts use the returned quote
decimals, even when fields contain `Wei`. These APIs index Bags deployments; they do not
discover or claim Plugged splitter balances. Solana uses `/fee-share/config` and
`/token-launch/claim-txs/v3`, with base58 transactions and distinct SDK semantics.

Public docs do not establish third-party OAuth access to a Bags-created Privy wallet, nor
guarantee the never-joined-profile lifecycle. A successful resolver response and API key do
not grant signing control. The owner must obtain control of the exact allocated EVM wallet;
for Plugged's permissionless fixed-recipient splitter, another caller may trigger payment,
but cannot redirect it. End-to-end onboarding, receipt and spending still require verification.

Source: https://docs.bags.fm/api-reference/openapi.json

### Charity tokens

The inspected official API supports wallet/social beneficiaries. It did not establish a
charity-verification API or failed-campaign refund system. GoodBags is a separate third-party
reference whose marketing was not independently verified:
https://goodbags.tech/charities and https://goodbags.tech/features

Keep these separate: creator label, resolved wallet, proof of wallet control, nonprofit
identity, endorsement of this campaign, and confirmed payment. One does not prove another.
Plugged now stores optional charity metadata explicitly as unverified, with a fixed
fundraising beneficiary. It never invents endorsement, tax deductibility or a donation receipt.

## Implemented programs and remaining connection points

- **Fundraising:** draft beneficiary/goal/UTC deadline plus `PluggedCampaign` escrow.
  Standard ERC-20 or ETH contributions; no early beneficiary payout. Goal success pays
  after the deadline. Failure permits individual pull refunds to original contributors.
- **Cashback:** draft rebate percentage of eligible fees and separate budget plus
  `PluggedCashback`. EIP-712 cumulative-fee vouchers are domain-bound, replay-resistant and
  budget-capped. An immutable trusted attestor must authenticate trades; no attestor service
  is implemented. A compromised attestor can allocate the entire funded budget.
- **Refunds:** mandatory failed-goal policy when fundraising is enabled, not general refunds
  of token-trading losses. Campaign balances cannot fund cashback.
- **Developer/community rewards:** complementary shares of post-platform revenue. Developer
  wallets divide that developer pool; community rewards mean balance-weighted holder
  dividends, not a second fixed-wallet splitter. Disabled developer rewards need no wallet.

Contracts are undeployed. Transaction submission, real eligible-trade indexing, recipient
claims, holder streaming, campaign funding UI and production deployment remain incomplete.
No production funding has been accepted by this preview.

## Anti-vamp identity

Merc's clarified rule is canonical name plus ticker plus identical economic settings, not
unconditional global ticker ownership. Different economic settings are explicitly allowed
for the same name/ticker. No referral program is requested. `PluggedLaunchRegistry` accepts registrations only from its immutable
factory and rejects a repeated key. ASCII case variants normalize to uppercase and name
whitespace collapses; non-ASCII names are compared byte-for-byte after ASCII normalization. Social metadata
and payout-wallet changes do not change the economics fingerprint. Local draft saves apply
the same duplicate rule without claiming to reserve a ticker on-chain.

The future factory must construct the hash from validated parameters and register in the
same transaction as deployment. A client-provided arbitrary hash is not sufficient. Other
factories/chains remain outside this registry. First registration is not proof of trademark
ownership, and atomic registration alone is not protection against front-running a public
factory launch. No production anti-vamp enforcement is claimed before factory integration.
