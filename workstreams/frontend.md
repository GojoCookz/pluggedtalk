# Frontend integration

## Final running-app verification — 2026-10-31

Ran the integrated suite against `http://127.0.0.1:4317` with `PLUGGED_UI_SERVER_KIND=production`. Health confirmed the requested process: **startedAt `2026-10-31T21:16:19.856Z`**. Observed configuration: **launchEnabled=true, programsEnabled=false**.

**All final browser gates passed:** 24 checks, 13 AccessLint states × 94 rules, zero accessibility violations or skipped rules, zero runtime errors, and zero captured CSP violations in both mocked active flows and real unconfigured screens. Ten screenshots were refreshed. Mobile 390×844 ran before desktop 1440×1000; inspected the Spanish dark Programs and labeled desktop trading captures. No audited state overflowed horizontally.

The browser runner now reads `/api/config` and probes only disabled preparation gates. This run verified the two disabled program gates and the real media error contract; it did not invoke enabled live trading/rewards preparations. Real media/program reads matched their expected unavailable/undeployed schemas. Active transaction flows still use explicit HTTP and wallet mocks; no wallet broadcast or provider upload occurred.

Updated evidence is in `artifacts/platform/report.json`, including target URL and observed signing flags. The running app and its configuration were preserved. The earlier 12-check launch regression below is from the separate port-4328 run, not a new launch-regression run against port 4317. Parent-reported backend/Anvil counts remain separate evidence.

## Previous isolated production HTTP retest — 2026-10-31

**Integrated browser gates now pass.** This section supersedes the historical failures below. A fresh instance of the actual `server.ts` ran on port 4328 with separate temporary SQLite stores, launch/program signing disabled, an empty program manifest and no pinning credential. The old preview process was not reused or restarted.

- Frozen build: **265,904 JavaScript bytes**, no new dependencies.
- Platform suite: **24 checks passed**, **13 AccessLint states × 94 rules**, **zero violations, zero skipped rules, zero browser runtime errors**, **10 screenshots**. The strict-CSP gate also passed with zero captured violations in the active-flow context. Owners removed the remaining inline styles and corrected voucher textarea focusability before this build.
- Existing launch regression: **12 checks passed, zero browser runtime errors** against the same fresh production server.
- Real production HTTP checks: media status and undeployed program list returned their expected schemas; trading/rewards/program preparation and voucher routes returned disabled-gate HTTP 503 responses; unconfigured media pin returned HTTP 503 with `code: "unavailable"`. No API mismatch was found in these exercised routes.
- Real unconfigured browser screenshots use actual production HTTP responses, with no interception or wallet injection. Active transaction flows remain explicitly labeled browser mocks. They establish frontend control flow, not successful production POST dispatch or live on-chain settlement; the parent owns the broader HTTP/service tests.
- Inspected the new 390×844 launch and Spanish dark Programs screenshots, then desktop trading. The Spanish refresh control remains intact, manual CID fallback is visible, and trading preserves its labeled mock data and honest empty chart. All audited states passed the horizontal-overflow check.
- Updated `tools/platform-browser-check.mjs` to record `base`, `serverKind` and accurate evidence scope, and to exercise the production disabled gates and media error contract. No backend or feature-owned files were edited during this retest.

Run against a fresh, unconfigured production instance after `bun run build`:

```powershell
$env:PLUGGED_URL='http://127.0.0.1:4328'
$env:PLUGGED_UI_SERVER_KIND='production'
node tools/platform-browser-check.mjs
node tools/launch-browser-check.mjs
```

Current evidence: `artifacts/platform/report.json`, `artifacts/launch-browser-check.json`, and `artifacts/platform/*.png`. Live configured deployments, real provider uploads and wallet broadcasts remain outside this verification. No commit or push was performed.

## Scope and design

Operate mode; functional integration within the existing vanilla JavaScript bundle. No dependencies added. Preserve the white/green tokens (`#f5f7f6`, `#fff`, `#14241c`, `#56665d`, `#087b46`) and their existing dark equivalents, native rounded headings, system body type and monospace addresses. The transaction receipt remains the signature. Mobile stacks controls before supplementary token data; desktop uses the existing two-column form/receipt layout. No new visual direction or invented market data.

Owned source: `web/app.js`, `web/launch.js`, `web/style.css`, `web/i18n.js`, `web/index.html`; integration evidence: `tools/platform-browser-check.mjs`, `test/platform-ui*`, this report. Feature modules and server/build/export files belong to their feature owners/parent.

## Integration contracts

- Trading: `tradingScreen({wallet,connect,language,esc})`, mounted only for a token returned by the confirmed Plugged market feed, into `#token-trading`.
- Earnings: `rewardsScreen({wallet,connect,language,esc}).mount(main)`.
- Programs: `programsScreen({wallet,connect,language,esc}).mount(main)` via `#programs`, both navigation bars.
- All transaction screens expose `invalidate()` and `destroy()`. Account, chain, disconnect and language events invalidate the active screen. Every inactive screen has already been destroyed and holds no preparation; this invariant invalidates all signable transactions without reconnecting dormant feature wallet listeners. Route/theme changes destroy the active screen before replacing its DOM.
- Media: `mediaUploader({language,esc,onPinned})` mounts beside the manual image CID field; provider-confirmed CID dispatches the existing input event to save the draft and invalidate review. Ordinary receipt updates preserve uploader-owned controls and requests; teardown destroys the uploader. Manual CID edits cancel/remount the uploader so late pins cannot overwrite them. Launch actions wait for an active upload or cancellation; cancellation remains operable.
- Launch now has explicit teardown and operation identity; late asynchronous completion cannot unlock a newer operation after route remount. Recovery hashes remain durable after actual wallet submission.

## Historical verification — before production HTTP retest

The actual four feature modules are imported and bundled, not stub replacements. Final measured frozen bundle: **267,209 JavaScript bytes** (`bun run build`). No dependency added. No feature-owned source, backend, build tool or exporter was edited. No commit, push, worktree, chain broadcast or paid provider upload was performed.

### Reproduce

From `plugged/`, run the existing build, then the isolated test-only adapter:

```powershell
bun run build
bun run test/platform-ui-server.ts
```

In a second terminal:

```powershell
node tools/platform-browser-check.mjs
$env:PLUGGED_URL='http://127.0.0.1:4327'
node tools/launch-browser-check.mjs
```

`PLAYWRIGHT_MODULE`, `CHROME_PATH`, and `ACCESSLINT_ENGINE` can override the existing local browser tooling paths. No tooling is installed by these scripts. The adapter serves the real frozen app, the real `MediaService` with an explicitly empty provider credential, and the real `ProgramService` with an empty manifest and in-memory store. It has **no write routes**. Active flows intercept HTTP in Playwright and inject an explicitly labeled test wallet. Unconfigured screenshots use actual service responses with no interception or injected wallet. This verifies frontend integration, not parent-owned production HTTP routing.

### Measured results

- Existing `tools/launch-browser-check.mjs`: **12 checks passed, zero browser runtime errors**. Separate approval and ETH funding, exact launch preparation, expiration, form/chain invalidation, persistent submitted hash, reload confirmation and manual recovery were exercised. Earlier timeout and listener-isolation failures were corrected; this final run is green.
- New `tools/platform-browser-check.mjs`: **23 functional checks completed** with zero `pageerror` events. The suite's final gate is **not green**: production CSP blocks feature-owned inline styles; the audit report also contains one remaining accessibility finding. Failures remain explicit and are not suppressed.
- Functional coverage: verified-token-only trade mounting; buy/sell, approval, balances, slippage and validity controls; holder claims, creator/pool sweeps, fixed-recipient release, cancel and social-provider failure; campaign approval/contribution/refund/payout; voucher retrieval/review/claim and separate cashback funding; image success/failure/cancel/type rejection/manual-CID preservation; account/chain/disconnect invalidation for all four transaction screens; late launch review after navigation; theme/language remount; guide disclosures, asset filters and keyboard skip navigation.
- AccessLint **94 rules × 13 states**: **12 clean states**, **one serious finding**, **zero skipped rules**. Finding: `keyboard-accessible/scrollable-region`, selector `label > textarea[name="voucher"]`, in mobile cashback. This is an automated finding on a native textarea, not a full manual WCAG verdict. Owner was asked to verify keyboard behavior and add explicit focusability if needed.
- **10 screenshots** saved under ignored `artifacts/platform/`; mobile **390×844 first**, desktop **1440×1000** afterward. EN/ES and light/dark are exercised. No horizontal page overflow in any audited state. Real-service unconfigured states: **five audits, zero violations/skips**.
- `artifacts/platform/report.json` contains every check, audit finding, screenshot path, network trace and failing gate. `artifacts/launch-browser-check.json` records the 12 passing launch checks.
- The Impeccable mechanical detector reported **no regex findings**, but explicitly ran in **degraded mode** because parser modules were unavailable. It did not check computed contrast or selector matching; the browser AccessLint runs are the relevant automated accessibility evidence.

### Visual critique and fixes

1. First mobile review showed a Spanish program refresh label breaking inside the word. Shared `.page-top > button` now prevents shrinking; the final screenshot shows “Actualizar” intact and the heading wraps naturally.
2. Native upload controls keep their own disabled/progress states; the launch receipt no longer re-enables an unavailable uploader. The image controls sit beside the manual CID, before economics, rather than after the launch action.
3. Trading precedes supplementary chart/metrics on mobile; desktop retains the source/receipt columns. Unknown prices remain em dashes and missing charts remain explanatory empty states.
4. Wallet notices gained a labeled landmark; language changes clear stale-language notices. Returning to Robinhood replaces a stale wrong-chain notice. The skip link now focuses `main` without changing the route.
5. Shared CSS contains the feature styles required by the strict CSP. Removing the redundant inline copies from feature-owned modules remains outstanding below.

## Historical blockers and ownership — superseded by latest result above

1. **Feature-owned inline styles still violate production CSP `style-src 'self'`.** Latest complete integration run recorded **570 repeated violation events**, not 570 distinct issues. `web/trading.js` still injects a `<style>` block; `web/rewards.js` contains inline wrapping/spacing/address styles; `web/programs.js` contains an inline refresh-button style. Shared equivalents are in `web/style.css`. Removal requests were queued to the owners; this session did not edit their files or weaken CSP. Rebuild and rerun the suite after their fixes.
2. **Mobile voucher textarea audit finding** remains owner-side. The suite records it without ignoring the rule. A follow-up was queued to the programs owner.
3. **Production HTTP end-to-end verification belongs to the parent.** At the early integration check, the existing parent server returned 404 for `/api/programs`; the isolated real-service adapter was added so screenshots do not mistake an unwired endpoint for verified deployment configuration. Parent must wire the documented endpoints and signing gates, then run the suite against an unconfigured production server via `PLUGGED_URL`.
4. **Deployment/provider gates are real:** no configured campaign/cashback deployment, verified live splitter, authorized real pinning upload or live trading/claim broadcast was supplied for this workstream. Browser mocks prove frontend control flow, not deployment or transaction success on-chain.
5. Existing **queued owner coordination waits timed out after 25 minutes**. No owner changes are assumed from those waits. The reports/source actually present at build time were used. Pending requests are in the trading, rewards and programs threads below.

The shared integration is implemented and its functional flows are exercised. Final cross-feature release verification remains incomplete until the explicit CSP/a11y and parent HTTP items above are resolved.

## Evidence and coordination links

- Trading owner: https://discord.com/channels/1530362963998015498/1566121183424806922
- Rewards owner: https://discord.com/channels/1530362963998015498/1566121186008633415
- Programs owner: https://discord.com/channels/1530362963998015498/1566121187208069140
- Media owner: https://discord.com/channels/1530362963998015498/1566121188764291122
- Review rules used: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
- Key screenshots: `real-unconfigured-launch-mobile-light.png`, `real-unconfigured-programs-mobile-dark-es.png`, `real-unconfigured-programs-desktop-dark-es.png`, `real-disconnected-rewards-desktop-light.png`, `mock-trading-mobile-light.png`, `mock-trading-desktop-dark.png`, `mock-programs-mobile-light.png`, `mock-programs-desktop-light.png`, `mock-rewards-mobile-dark-es.png`.
