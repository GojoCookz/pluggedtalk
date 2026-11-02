# Plugged expanded-planner verification

## Carbon launch MVP addendum — 2026-10-31

The live launch scope is now documented in `MVP-HANDOFF.md`. Five deployed-engine fork
tests passed at block 102239693 (USDG, cbBTC, WETH, local-approved AAPL launch/buy/sell,
and native ETH funding). This is fork execution, not a mainnet broadcast. Live public-HTTPS
preparation returned HTTP 200 with current USDG pricing and the correct funding-required state.
The expanded browser suite has 28 planner checks plus 12 wallet-state checks; automated
accessibility covers 28 combinations with zero violations/skipped rules. The latest artifact
files are authoritative. The sections below record the prior planner milestone.

## Measured final checks

- Bun: **70 passed, 0 failed**, **1,188 expectations**, six files. Includes exact-integer
  curve math, partial-fill refunds, fee conservation, hybrid validation, name/ticker/economics
  identity, no-referral policy, catalog and HTTP boundaries, fixed USD conversion,
  social resolution receipts, expiration/tamper checks and ETH-route validation.
- Foundry forced full compilation: **36 passed, 0 failed, 0 skipped**, six suites.
  Splitter, campaign and cashback invariants each ran **256 runs / 16,384 calls / 0 reverts**.
- `forge fmt --check`, `forge lint` and `forge build --sizes` completed successfully.
  Lint retains a non-failing `asm-keccak256` optimization note for the registry's standard
  dynamic ABI encoding; hand-written assembly was not introduced for a micro-optimization.
- Runtime bytecode: splitter **2,763 B**, campaign **3,208 B**, cashback **5,100 B**,
  name-aware launch registry **2,633 B**. All are undeployed.
- Frozen frontend: **177,123 JavaScript bytes**, existing Bun/viem dependencies, no new packages.

## Browser and accessibility evidence

`tools/browser-check.mjs`: **28 checks, zero failures, zero runtime errors**. Includes:

- No Carbon launch cards; honest Plugged-only empty state and network failure state.
- Delayed old USD-conversion response discarded after changing quote selection.
- Fixed $2,500 USD opening, $40,000 default milestone; eligibility/mode controls absent.
- Independent ETH/stock hybrid pools, add/remove market controls, shared USD opening,
  persisted economics and export. Connected-wallet native ETH preview and mocked positive
  USD-conversion rendering are verified separately from live provider pricing.
- X/GitHub allocations persist; unavailable resolver produces an explicit configuration error.
- Delayed price, route and profile errors are discarded after their inputs change. Editing
  a profile clears its displayed resolution; account changes clear the ETH-route preview.
- Duplicate name/ticker/economics blocked despite changed payee; changed surcharge allowed.
- Independent drafts, save/reload/edit/delete, cancellation, reward toggles, complementary
  ratios, community-only recipients, campaign/refund/cashback and social persistence.
- Light/dark and English/Spanish persistence; wallet absence, keyboard dismissal and events.

`tools/accessibility.mjs`: **24 combinations × 94 rules**, **zero violations / zero skipped**.
Matrix: Discover, Create with hybrid controls, Create with social controls, Earnings, Assets,
Guide; light/dark; mobile **390×844** and desktop **1440×1000**. AccessLint core 0.21.0 runs
inside installed Chromium using cached tools. It is automated evidence, not full WCAG or
screen-reader certification. Reports and screenshots live in ignored `artifacts/`.

## Campaign invariant correction

The preceding run's 424 handler reverts were investigated. An unbraced nested `if` bound
`else` to the inner payout check: failed campaigns were never refunded by the handler,
while repeated successful finalization attempted an invalid refund. Explicit braces fix
both paths. A deterministic regression now exercises failed-goal refunds and repeated
successful finalization. The corrected campaign invariant has zero reverts. This was a
test-handler defect; production campaign code was not changed for this correction.

## Research evidence

Catalog: 203 issuer stock addresses, 31 Carbon quote references, 357 LI.FI entries,
469 unique assets, 365 observed pools (193 stock-containing). Code and expected decimals
were checked over blocks 102107192–102107323, snapshot 2026-10-30T23:21:17.369Z.
Provider-observed pools are not an exhaustive factory-event index. No asset is labeled
Wormhole-verified; complete authenticated Wormhole/NTT enumeration remains unavailable.

Pons: retained reads at blocks 102120191, 102120668 and 102122189. Presets include 85 approved
ERC-20s and native ETH. Provenance and reconstruction caveats are in `data/pons-reference.json`.
Approval is not bridge authenticity. Exact V4 rounding, graduation seeding, tax decay and
fresh source-to-bytecode verification remain unresolved; retained arithmetic is research-only
and visible Pons controls have been removed. RESEARCH.md records the Pons V1/V2/direct-V4 distinction.

Read-only live integration at **2026-10-31T00:44:32.575Z** verified ETH, USDG and AAPL USD
prices plus an ETH → USDG funding quote. This predates strict ceiling-rounding validation;
the final validator is unit-tested. No live social resolution was run because `BAGS_API_KEY`
is absent. Signed receipts were tested with controlled fixtures. The API key alone would
not prove rightful-owner onboarding or access to the provider-created EVM wallet.

## Limits and failed tooling

- `forge coverage` still fails on mixed Windows import separators. **No coverage percentage
  is available.** The installed WSL wrapper delegates to Windows `forge.exe`; native Linux
  coverage remains a release prerequisite. Full tests above used `--force` to avoid partial
  artifacts left by coverage/incremental compilation.
- A PowerShell stderr wrapper mislabeled an earlier successful Foundry check as exit 1.
  Redirecting inside Bash produced a successful final command and retained lint evidence.
- Earlier browser verification failed because its fixture expected an unsaved hybrid form
  to survive a full reload. The test now explicitly reopens the saved draft; final run passes.
- The new stale-response tests dirtied the form before creating the next fixture. One run
  failed because Playwright dismissed the unsaved-change dialog; the fixture now explicitly
  accepts it. The final 28-check run passes.
- Critique's default collector reported no changes despite Git-visible additions. An explicit
  scoped `git diff --relative -- plugged` piped to `critique --stdin` converted successfully,
  then upload failed with “Unable to connect.” Earlier connectivity checks failed TLS
  negotiation. **No published diff URL is available.**
- No launch, trade, approval, claim or deployment was sent. Factory integration, strict 3%
  token enforcement, holder streaming, eligible-trade attestation and live funding/claim UI
  remain incomplete. Atomic ETH → Plugged-token routing, social-owner wallet access and
  external terminal milestone indexing are also incomplete. `/api/readiness` returns false.
  Local anti-copy checks are not global reservations or front-running
  protection; Unicode lookalike matching and cross-platform enforcement are not provided.

## Review trail

The earlier finish reviewer identified quote-state synchronization; its targeted fix is now
covered by the delayed-response browser check. Mobile/light, mobile/dark and desktop captures
were inspected during this pass. Prior first-preview review verdicts do not certify this
expanded contract set or production readiness.
