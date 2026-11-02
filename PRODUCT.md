# Plugged

## Brief and scope

New Robinhood EVM launchpad for Merc. Source: the user-provided Telegram export
`ChatExport_2026-10-30/messages.html`, messages 410547–410567. The export identifies
speakers as 0xGojo and Woozy; it does not establish which speaker is Merc.

**Operate mode.** Traders should see coins immediately. Creators should understand who
receives fees before creating a token. White and green, light/dark themes, languages,
iOS-like clarity, and early pump.fun's direct market-first composition are pinned brief
requirements. No marketing hero and no fabricated market activity.

## Requirements ledger

| Requirement | Evidence | Initial implementation / remaining work |
|---|---|---|
| Name: Plugged | 410547 | New isolated app in `hoodstonk/plugged` |
| Pair with any coin | 410548 | Indexed quote catalog with issuer stocks and crypto references; code/decimals-checked draft selection. Production onboarding remains pending. |
| GitHub fee redirection | 410549, 410566, latest follow-up | X/GitHub recipient allocation, explicit Bags EVM resolution and signed identity-to-wallet receipts implemented. Rightful-owner wallet access and live claiming pending. |
| Fundraising / cashback | 410550, confirmed follow-up | All three requested: fundraising, cashback and failed-goal refunds. Draft configuration and undeployed contracts implemented. |
| 2–3 / max 3% per wallet | 410551 clarified by 410566 | Draft policy fixes 300 BPS. Strict creator-opening-buy enforcement requires a fresh launcher/token integration; legacy launcher has an exemption. |
| Built by trenches for trenchers | 410552 | Market-first voice and compact browsing |
| Bags feature breadth | 410558 and user request | Parity ledger in RESEARCH.md; full parity is a roadmap, not current status. |
| White/green, light/dark, language | 410560 | Light-first, persistent dark mode and English/Spanish interface |
| Outside-crypto recipient onboarding | 410561–410563 | Identity-claim onboarding pending |
| Simple professional iOS architecture, RH ETH | 410564 | Native system typography, familiar navigation, ETH gas, no custody |
| Trending + launches first | 410566, corrected follow-up | Plugged-only market, empty until deployment. Carbon launch listings removed. |
| Creator and/or community fees | 410566 | Validated recipient plans; immutable multi-recipient fee splitter contract, separate from streamed holder dividends |
| Dexscreener chart | 410567 | Only display embed after provider returns a matching indexed pool. Otherwise explain absence. |

## Confirmed follow-up requirements

The user confirmed all three programs: beneficiary fundraising, trader cashback and
failed-campaign refunds. The launch form must offer developer/community reward toggles
and explicit ratios, social links, and optional charity designation. Charity labels and
social URLs are metadata, never beneficiary verification.

Plugged discovery must contain only Plugged launches. Carbon launch tokens must not appear
in the interface. Carbon's technology, feature references and quote-asset addresses remain
research inputs; they are not Plugged listings. Until a Plugged launcher is deployed the
market has an explicit empty state.

Index stock and Wormhole assets separately as quote-asset research, with provenance,
address-based identity, completeness and verification status. Indexing does not itself
approve an asset for a production launch.

### Follow-up interface plan

Merc's later Telegram clarification (screenshot supplied 2026-10-30, messages at 7:40–7:51 PM)
requires exact-configuration anti-copy protection: the same **name + ticker + economic
settings** cannot be duplicated. The same name/ticker with different economic settings is
explicitly allowed. This is not exclusive ticker ownership. Canonical ticker, normalized
name and economics determine the fingerprint; changing recipient wallets or social metadata
does not change that key. ASCII case and whitespace normalize; Unicode lookalike detection
is not implemented. Merc explicitly declined a referral program. No referral fees, rewards,
codes or legacy Carbon referral integration belong in this build.
The registry is scoped to the authorized Plugged factory and must register atomically
with deployment. It cannot prevent tokens on other permissionless factories/chains.
Until factory integration is deployed, local draft duplicate checks are not global protection.

Keep the existing native system typography, white/green tokens and mobile navigation.
Replace the ecosystem switcher with a Plugged-only market. Put the quote catalog in the
guide and market-selection workflow, not among newly launched coins. The fee receipt is
still the signature element: developer and community toggles expose percentages of the
same post-platform pool and must sum to 100%. Optional program sections use native
checkboxes and show their accounting boundaries, not invented funding or earnings.

## Delivery boundary

This first build is a Plugged-only market shell plus a persistent local launch planner and
a tested fee-recipient contract. It does not publish launches, execute trades, verify GitHub
identities, or distribute live rewards. Those states are explicit in the interface.
Connecting a wallet requests only the public address. Drafts stay in this browser, are
exportable, and never become listings merely because they were saved.

## Confirmed universal economics

- One direct-V4 flow; no user-facing Pons preset or mechanism selector.
- Opening market cap is **$2,500 USD FDV**, meaning price × the full one-billion-token
  supply. Initial token price is $0.0000025. This initializes valuation; it is not a USD peg.
- Default graduation milestone is **$40,000 USD FDV**, editable above the opening value.
  This is a Plugged product choice, not a verified Pons dollar constant. Trading remains
  in the same V4 pools. Third-party terminal recognition requires an explicit integration.
- Native ETH on Robinhood funds buys. The current preview quotes ETH → selected quote;
  final atomic quote → Plugged-token execution and Ethereum-L1 bridging remain unimplemented.
- All quote catalog addresses are configured centrally. The eligibility button is removed;
  runtime liquidity, safe asset behavior and future factory policy still require verification.
- Every hybrid pool uses the same full-supply USD valuation, converted to its quote units.
- Developer rewards can be assigned to another person's X or GitHub profile. This supports
  creators' work through fee allocations; fundraising remains a separate escrow program.

## Remaining economics and deployment decisions

1. All three programs are requested. Fundraising uses a fixed beneficiary, target and
   deadline; a missed goal returns contributions. Cashback is separately funded and must
   be backed by authenticated eligible trades, not taken from refundable contributions.
2. Confirm fees, platform treasury and recipient policy. The existing hook charges a flat
   100 BPS of volume before other allocations; copying Bags' headline fees is not valid.
3. Confirm provider-supported owner onboarding and control of the resolved EVM wallet.
   A GitHub repository URL or organization is not an implemented claim authority.
4. Agree the terminal-specific graduation read/event interface and USD observation policy.
   A draft milestone does not guarantee any external terminal displays a progress bar.
5. Confirm cap duration. Proposed strict lifetime 3% holdings cap includes creator receipt;
   infrastructure exceptions must be fixed at deployment. Multiple wallets remain possible.

Stock assets are included in the read-only catalog at the user's request. Carbon's
existing transaction eligibility rules remain source metadata, not a reason to omit them.
