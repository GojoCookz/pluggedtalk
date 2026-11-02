# Plugged — developer handoff for Merc

> Historical planner-only handoff. Superseded by [MVP-HANDOFF.md](MVP-HANDOFF.md), which
> documents the implemented Carbon-backed launch flow and remaining registry-owner approvals.

Prepared 2026-10-31 UTC. This is a runnable preview and source handoff, **not a deployed
or production-ready launchpad**. No launch, trade, claim, approval or deployment was sent.

## 1. Start the delivered ZIP

Extract the entire ZIP, install Bun (tested with 1.3.9; https://bun.sh), and open a terminal
inside `plugged-merc/`:

```sh
bun run start
```

Open http://localhost:4317/#create. The ZIP includes the frozen frontend and a bundled
backend; this preview requires no package installation. It must be served, not opened
as an HTML file. Keep the terminal running. `PORT` overrides 4317. The server listens on
loopback; put an HTTPS reverse proxy or tunnel in front when sharing it.

For source development, install the pinned dependency and rebuild:

```sh
bun install --frozen-lockfile
bun test test/
bun run build
bun run start
```

`bun run dev` runs the source backend after installing dependencies; it still serves
the frozen frontend, so rebuild after frontend changes. `bun run build` refreshes both
frontend and bundled backend in this archive. No Hood checkout is needed.

For contract tests, install Foundry (https://getfoundry.sh), then:

```sh
cd contracts
forge test -vv
forge fmt --check
forge build --sizes
```

OpenZeppelin and forge-std source dependencies are included under `contracts/lib/` with
their licenses and commit provenance. Compiler is Solidity 0.8.26, Cancun EVM. Foundry may
need internet access to obtain the compiler. Windows coverage had an import-separator
failure in the original workspace; no coverage percentage is claimed.

## 2. Product decisions already implemented

- Robinhood chain **4663**, native ETH input.
- Fixed **$2,500 USD opening FDV** across quote assets; one-billion-token full supply.
- One **direct Uniswap V4** launch plan. Default **$40,000 USD FDV milestone**, editable;
  the milestone does not move liquidity to another pool.
- Hybrid plans divide supply across 2–4 independent pools at the same USD opening FDV.
- 1% base fee model, 30% of that base fee to platform (0.30% of volume), optional creator
  surcharge 0–10%; developer/community percentages divide post-platform revenue.
- Up to 100 wallet/X/GitHub recipients. Social allocation is separate from fundraising.
- Fundraising, failed-goal refunds and separately funded trader cashback plans.
- Proposed 3% wallet cap. No referrals. Anti-copy identity is normalized name + ticker +
  economic settings; the same name/ticker with different settings is permitted.
- White/green, light/dark, English/Spanish, local draft save/edit/delete/export.
- Plugged-only discovery; no borrowed Carbon launches. Catalog: 469 unique assets,
  including 203 issuer stock addresses; 365 provider-observed pools. Catalog inclusion
  does not guarantee a route or future on-chain approval.

## 3. Architecture and source map

```text
Browser (web/ → dist/)
  ├── localStorage drafts, themes, language; wallet address connection only
  └── Bun HTTP server (server.ts → server.bundle.js)
        ├── lib/plan, economics, fingerprint: validation and identity
        ├── lib/market-services, usd: LI.FI prices and ETH funding quotes
        ├── lib/recipients, social-service: Bags identity resolution + HMAC receipts
        └── data/: address catalog and provenance-bearing research snapshots

contracts/src/ (tested, undeployed)
  ├── PluggedFeeSplitter: fixed recipients, cumulative claims
  ├── PluggedCampaign: escrow, deadline, beneficiary payment or contributor refunds
  ├── PluggedCashback: separately funded EIP-712 cumulative vouchers
  └── PluggedLaunchRegistry: authorized-factory anti-copy registration
```

API: `GET /api/config`, `/api/assets`, `/api/markets`, `/api/valuation`,
`/api/readiness`, `/api/pons-reference`; `POST /api/plans/validate`, `/api/plans/prepare`,
`/api/recipients/resolve`, `/api/routes/quote`. The server exposes only the frontend file
allowlist and these APIs, not source files or secrets. There is no database or publisher.

## 4. Integrations and secrets

Copy `.env.example` to `.env`; never commit or share populated secrets.

- `BAGS_API_KEY`: server-only key from https://dev.bags.fm. Resolver explicitly requests
  `chain=EVM` and may create a Privy embedded wallet. No live resolution was tested without
  a key. Signed receipts bind provider ID, username and wallet, expiring after 24 hours.
- `PLUGGED_SOCIAL_RECEIPT_SECRET`: persistent cryptographically random secret, at least
  32 bytes. Without it, server restart invalidates existing resolution receipts.
- `PORT`: optional, default 4317. No private signing key is required for the preview.

An API key does not establish rightful-owner access to a Bags-created wallet. Confirm the
Bags/Privy cross-app onboarding contract and test a never-joined profile through receipt
and use of funds. Bags claim APIs index Bags deployments, not Plugged splitters.

ETH routing currently verifies **ETH → quote asset only**, returning `executable: false`.
ETH means Robinhood native ETH, not Ethereum-L1 bridging. USD prices are indicative;
retrieval time is not the underlying price timestamp. Do not treat cached prices as
transaction-ready initialization inputs or assume bridged WETH has `deposit()`.

## 5. Work required before launch

1. Integrate and deploy the Plugged factory/token, strict 3% creator-and-wallet cap, atomic
   registry registration and fee/holder distribution. The legacy launcher has exemptions.
2. Implement atomic ETH → quote → launch-token routing with final output, recipient,
   deadline and fee enforcement; fresh USD initialization and pinned-fork simulations.
3. Complete social-owner onboarding, wallet access and Plugged-specific rewards reads/claims.
4. Wire campaign funding/refunds, cashback funding/claims and authenticated trade attestation.
5. Add metadata publication, launch indexing, Dexscreener matching and explicit terminal
   milestone integration. No universal direct-V4 migration metadata standard was verified.
6. Configure treasury/operational identities, production authentication/rate limits, persistent
   services and deployment verification; independently review the complete money paths.

`GET /api/readiness` deliberately returns `ready: false`. Supplying credentials alone
does not complete the missing contracts or integrations.

## 6. Evidence and references

Original workspace verification: **70 application tests**, **36 contract tests**,
**28 browser checks**, all passing. Three invariants: 256 runs / 16,384 calls / zero reverts
each. Automated accessibility: 24 combinations × 94 rules, zero violations/skipped.
These are not full WCAG certification or an independent security audit. Packaging checks
and exact hashes are recorded separately in `PACKAGE-MANIFEST.json` and `HANDOFF-CHECKS.json`.

The ZIP includes `evidence/` with the existing browser/accessibility/provider reports and
two focused screenshots using explicitly named test profiles. `PRODUCT.md`, `DESIGN.md`,
`FEATURES.md`, `RESEARCH.md`, `ASSETS.md` and `VERIFICATION.md` preserve decisions and limits.
`WORKSPACE-README.md` documents the original sibling-dependency setup; use this README
instead for the standalone archive. The archive contains no `.env`, keys, wallet secrets,
private chat export, unrelated project source, node_modules or Git history.

- Bags EVM identity: https://docs.bags.fm/api-reference/get-fee-share-wallet.md
- Bags Robinhood claims: https://docs.bags.fm/robinhood/claim-fees.md
- Bags Solana claims: https://docs.bags.fm/how-to-guides/claim-fees.md
- Pons mechanisms: https://docs.ponsfamily.com/docs and https://docs.ponsfamily.com/docs/v2
- LI.FI quotes: https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer

Pons' observed USDG parameters imply **39,641 USDG** terminal FDV, not a fixed dollar cap.
Excluding locked excess produces **36,405 USDG**, an inference rather than verified display
behavior. Plugged's $40,000 milestone is an explicit product choice.
