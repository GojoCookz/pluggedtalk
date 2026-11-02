# Plugged

A new Robinhood EVM launchpad build, isolated inside the Hood workspace.

**Current status:** Carbon-backed launch preparation, ETH funding, approval and wallet
signing, durable receipt verification and Plugged-only discovery are implemented.
Read [MVP-HANDOFF.md](MVP-HANDOFF.md) for deployment instructions and verified boundaries.
Of 469 configured ERC-20 pairs, 31 are approved; 438 need the registry owner's signature.
The older planner/program inventory below is retained as historical/post-MVP context.

## Run

Requires the existing Hood workspace dependencies in `../app/node_modules`, Bun, and
the existing contract libraries in `../contracts/lib`. No new packages are installed.

```sh
cd plugged
bun run build
bun run start
```

The server binds to `127.0.0.1:4317` and serves only frozen `dist/` files. Change `PORT`
to override it. No server signing key is required. Set `PLUGGED_LAUNCH_ENABLED=true`
to enable the wallet-signed launch flow. Social integration is not required for the MVP.

## Historical planner/program inventory (superseded for live launches)

- Plugged-only market endpoint and honest undeployed empty state. No Carbon launch reads.
- Separate searchable quote catalog: 203 issuer stock addresses, 31 Carbon quote references,
  357 LI.FI entries, 469 unique assets and 365 observed pools in the current snapshot.
  Code/decimals and provenance are distinct from bridge authenticity and launch approval.
- Light/dark themes, English/Spanish, mobile navigation and EIP-6963/injected wallet
  address connection. There are no signature, approval or transaction requests.
- Validated local drafts, independent draft identities, editing/deleting, JSON export,
  recipient allocations up to 100 wallets or X/GitHub profiles, complementary developer/community reward
  toggles and ratios, indexed quote selection and a proposed 300-BPS wallet policy.
- Website, X, Telegram, Discord, GitHub, Farcaster and YouTube links; optional unverified
  charity designation. Links never establish payout authority or endorsement.
- Fundraising beneficiary, target and UTC deadline; required failed-goal refunds;
  separately budgeted fee cashback. All settings persist and export with the draft.
- One direct-V4 launch policy: fixed **$2,500 USD opening FDV**, editable **$40,000 USD
  default graduation milestone**, and no pool migration. Hybrid drafts plan 2–4 pools at
  the same full-supply USD valuation. Exact integer conversion uses current provider prices.
- ETH-on-Robinhood funding-route previews, including live ETH → USDG verification. All
  responses remain non-executable; the final atomic Plugged-token swap is not implemented.
- Explicit X/GitHub wallet resolution through Bags' EVM API, with identity-bound signed
  receipts. Unresolved, altered or expired mappings cannot pass launch preparation.
- All catalog addresses enabled in central draft configuration; no user eligibility button.
  This is not a claim that an undeployed factory already approves them or that all have routes.
- Pons snapshot API and curve arithmetic retained as research inputs, not launch-mode controls.
- Merc's clarified anti-copy rule: duplicate name + ticker + economics is blocked; the same
  name/ticker with different settings is allowed. Case/ASCII whitespace normalize; changing
  links or payee wallets cannot bypass the key. Local checks plus undeployed factory-only
  `PluggedLaunchRegistry` are implemented. **No referral program.**
- A view of recipient allocations with an explicit distinction between trading volume,
  platform revenue, holder rewards and the funded creator-recipient pool.
- `PluggedFeeSplitter`: immutable recipients/shares/one quote currency, permissionless
  triggering of payments to fixed recipients, ETH or standard ERC-20, cumulative rounded
  claims, reentrancy protection and independent receiver failure isolation.
- `PluggedCampaign`: standard-token/ETH contribution ledger, fixed beneficiary, post-deadline
  payout on success, individual refunds on failure. No cashback access to escrow.
- `PluggedCashback`: separately funded budget, EIP-712 cumulative eligible-fee vouchers,
  fixed attestor/rate, replay protection and fixed-recipient claims. Trade attestation is
  an explicit trusted service requirement, not a deployed integration.

## Not implemented or deployed

Dedicated Plugged launcher/token, factory integration of anti-copy protection, strict on-chain 3% creator cap, final token-swap quoting/submission,
IPFS publishing, social-owner onboarding and wallet control, reward-claim frontend,
keeper, full Wormhole enumeration, live program funding/claims and arbitrary quote onboarding. The old Hood launcher
exempts launcher-origin deliveries from its holding cap and permits a 10% unvested opening
buy; plugging a 3% value into its form would not enforce the requested promise.

No treasury or legacy referral configuration is silently reused. New fee economics and
beneficiary rules must be explicit before integration. See [PRODUCT.md](PRODUCT.md) for
the ambiguous notes and [RESEARCH.md](RESEARCH.md) for the source-backed reuse/parity map.

## Verify

```sh
bun test test/
bun tools/check-integrations.mjs
node tools/browser-check.mjs
node tools/accessibility.mjs
cd contracts
forge fmt --check
forge lint
forge test --force -vv
forge build --sizes
forge coverage
```

On this machine Foundry is invoked through WSL. The installed `/usr/local/bin/forge` is a
wrapper around Windows `forge.exe`; `forge coverage` currently fails resolving mixed-separator
OpenZeppelin/forge-std paths. Unit/fuzz/invariant tests pass; coverage has **not** been
measured. A failed coverage run can leave incomplete compilation artifacts; `forge test
--force` restores and verifies the complete suite. Do not interpret “No tests found” as pass.

Browser tools reuse an existing cached Playwright and Chrome installation. Set
`PLAYWRIGHT_MODULE`, `CHROME_PATH`, `ACCESSLINT_ENGINE` and `PLUGGED_URL` for other machines.
Browser fixtures are explicitly labeled and exist only in an isolated browser context;
they are not seeded into the application. Screenshots and reports go in ignored `artifacts/`.

## Integration setup and readiness

Copy `.env.example` to an ignored `.env` in this directory. Obtain `BAGS_API_KEY` from
https://dev.bags.fm and store it only on the server. Set `PLUGGED_SOCIAL_RECEIPT_SECRET`
to a cryptographically random secret of at least 32 bytes for restart-stable receipts;
without it, the server generates a process-local key and restart invalidates old receipts.
Start from this directory with Bun so its environment loading applies. Never expose these
values in the browser bundle, exported plans, logs or source control.

The user explicitly clicks **Resolve recipient wallet** before `/api/recipients/resolve`
calls Bags; the API may create an embedded EVM wallet. Requests are JSON, same-origin
checked and globally limited to ten resolution attempts per minute per server process.
These preview controls are not production authentication or distributed rate limiting.
No live resolver test has been performed because no API key is configured.

`GET /api/readiness` reports `ready: false`. `POST /api/plans/prepare` validates signed
social mappings and produces a recipient list, but does not create transaction calldata.
An API key enables resolution only. It does not establish that a profile owner can log into
Plugged and control the Bags-created wallet. Bags/Privy must confirm that onboarding path;
then test a never-joined profile resolving, receiving rewards and accessing the same EVM wallet.
Bags claim APIs index Bags deployments, not Plugged's independent splitter.

`GET /api/valuation` returns indicative USD conversions with a 60-second retrieval cache.
`POST /api/routes/quote` returns a non-executable ETH → quote-asset funding summary, with
30-second expiry for provider quotes. ETH means native ETH on Robinhood chain 4663;
Ethereum-L1 bridging is a separate unimplemented flow. No bridged WETH `deposit()` is assumed.
Final token swaps need an atomic router enforcing recipient, deadline, fees and minimum output.
Launch initialization needs execution-time repricing and simulation, pinned-fork verification,
the strict-cap factory/token, holder rewards, deployment and terminal-specific indexing.

## Contract integration details

The splitter is designed for the launcher's existing `feeRecipient` slot, but is not yet
wired to a new deployed launcher. It accounts only for its chosen currency. Do not send
other tokens to it: no privileged rescue path exists. Negative-rebasing tokens are
unsupported; taxed outbound transfers revert rather than falsely record full payment.
An immutable recipient that can never accept payment cannot receive its allocation.
GitHub names and `planHash` do not grant entitlement; only configured wallet addresses do.

Before production integration, pin compiler/library commits, run coverage on working
Foundry, complete hook/launcher pinned-fork integration tests, and review the exact
economic and deployment paths. No production-readiness claim is made by this build.
