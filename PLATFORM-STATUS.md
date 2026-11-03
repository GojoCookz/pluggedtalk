# Plugged platform implementation status

This ledger distinguishes implemented code, verified behavior and live activation. It is
not a claim that a deployed financial service is ready. Updated by the integration session.

## Parallel implementation

The user authorized parallel development on 2026-10-31. All teams share the existing
checkout, with explicit file ownership. No team is authorized to commit, push, broadcast
mainnet transactions or transfer ownership as part of this implementation pass.

| Workstream | Scope | Status | Thread |
|---|---|---|---|
| Trading | Verified Plugged token quotes, approvals, buy/sell and wallet UI | HTTP connected; service suite passes; no live trade broadcast | https://discord.com/channels/1530362963998015498/1566121183424806922 |
| Rewards | Creator/holder claims, splitters and social-beneficiary boundaries | HTTP connected; service suite passes; no configured live splitter | https://discord.com/channels/1530362963998015498/1566121186008633415 |
| Programs | Campaign contributions, payout/refunds, cashback indexing/vouchers | HTTP connected; isolated Anvil flows pass; production manifest/attestor absent | https://discord.com/channels/1530362963998015498/1566121187208069140 |
| Media | Validated image upload and provider-backed IPFS pinning | HTTP connected; mocked-provider PNG and cancellation checks pass; live provider unverified | https://discord.com/channels/1530362963998015498/1566121188764291122 |
| Deployment | Independent engine tooling, verified profiles, advanced launch contracts | Tools and Solidity import closure packaged; runtime remains pinned Carbon baseline | https://discord.com/channels/1530362963998015498/1566121184276381868 |
| Operations | Consistent backups, restore verification and production templates | Packaged; clean install/backup/restore tests pass; hosting not activated | https://discord.com/channels/1530362963998015498/1566124028777730058 |
| Frontend | Shared navigation, account lifecycle and browser verification | Running-app browser gates passed: 24 checks, 13 automated accessibility states, zero CSP/runtime findings; active transactions mocked | https://discord.com/channels/1530362963998015498/1566125343675519026 |
| Advanced runtime | plugged-advanced-v1 encoder, preparation, receipt confirmation, routes and `#advanced` UI | Connected and tested with mocked RPC; fails closed until a verified advanced profile exists; nothing deployed | https://discord.com/channels/1530362963998015498/1566370453696552960 |
| Integration | HTTP routing, cross-feature verification, readiness and portable package | Connected APIs and portable smoke verified; final evidence in workstreams/integration.md | https://discord.com/channels/1530362963998015498/1566162897900404899 |

Each team records its API contract, results and remaining blockers in `workstreams/`.

## Handoff pass — 2026-11-03

Entry point for Merc: `HANDOFF.md`. Thread: https://discord.com/channels/1530362963998015498/1565852347630887004

| Item | Status |
|---|---|
| Robinhood Chain / Uniswap v4 standards | Reviewed with live measurements: `workstreams/standards-2026-11.md`; `tools/rh-chain-probe.mjs` pins 11 code hashes. No compiler/target/address change needed |
| Audit M2, L5, L6, L9, L10 | Fixed with tests (see audit Fix status) |
| Audit L-2 on a 4663 fork | Not run; 32M max tx gas measured on 4663, launch measured 19.6M on Anvil |
| EIP-5792 batching, Permit2 | Deferred with reasons (standards doc section 4) |
| Languages (13 locales) | **Not done.** UI remains English + Spanish. ~544 inline string pairs plus the `web/i18n.js` table must move to keyed per-locale files and be translated into 11 more languages; deferred so the handoff could be verified on a memory-constrained host |
| Package | See "Handoff package" below |
Feature modules do not count as delivered until connected to the server and interface.

## Existing verified baseline

The launch MVP has wallet-signed ETH funding, quote approval, launch simulation,
receipt-verified discovery and durable recovery. See `HANDOFF.md` (current) and `MVP-HANDOFF.md` for the exact
historical test results and deployed-engine limitations. Historical results do not certify
the additions above. The current live launch path supports one pair and one creator wallet.

## Activation dependencies

- The last pair snapshot has 31 approved assets and 438 requiring the existing registry
  owner's authorization. The locally configured signer is not that registry owner.
- Independent ownership is a deployment plan. The local signer remains the intended
  owner; Merc's template owner and platform-recipient addresses remain empty.
- A new engine, splitter or program requires deployment and address/code verification
  before users can fund it. New code does not change the shared Carbon engine's rules.
- Provider-backed pinning and social onboarding require actual provider configuration.
- Stable production hosting needs a configured host and domain; a tunnel is a preview.
- `/api/health` asserts process liveness only. `/api/readiness` separates catalog coverage,
  signing flags, provider configuration and worker state; `productionReady` remains false.
- The advanced ABI now has a dedicated encoder and receipt integration
  (`workstreams/advanced-runtime.md`), activated only by a verified `PLUGGED_ADVANCED_PROFILE`.
  No advanced factory is deployed, so it reports unavailable. Baseline launch stays pinned Carbon.
- Windows source/bundle smoke verifies HTTP startup, assets and disabled gates. SIGTERM exits
  with code 143 on this host; Linux signal-driven graceful shutdown still needs host validation.

## Completion criteria

1. Each feature has tested service code and a connected UI with honest unavailable states.
2. Wallet account/chain changes invalidate transaction preparations.
3. Only exact, verified contracts and confirmed Plugged records are actionable.
4. Application, contract and browser checks are run against the integrated changes.
5. The portable package includes the new code and documentation, while excluding secrets,
   populated ownership plans and runtime databases.
6. Live activation dependencies remain explicit rather than being reported as completed.
