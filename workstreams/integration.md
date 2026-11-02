# Shared HTTP integration

## Ownership and contract

This workstream owns `server.ts`, `lib/http-api.mjs`, HTTP/integrated API tests,
`.env.example`, `tools/package-handoff.mjs`, `PLATFORM-STATUS.md` and this report.
Existing uncommitted work is preserved. No commits, pushes, worktrees, mainnet broadcasts
or bot restarts are authorized or performed.

All implemented service contracts in the trading, rewards, programs and media reports
are connected through an explicit HTTP route allowlist. `createPlatformServer(options)`
supports server-side dependency injection for deterministic HTTP tests. Production uses
one LaunchService; trading, rewards and programs share its SQLite handle. The programs
owner added backwards-compatible non-owning store injection for this integration. An
explicit separate program path remains available for existing operators.
No HTTP input selects a provider, deployment manifest, signer or method name.

`PLUGGED_LAUNCH_ENABLED` gates launch/funding, trade preparation and reward preparation.
`PLUGGED_PROGRAMS_ENABLED` independently gates program preparation and voucher issuance.
All submit/status recovery routes remain accessible while signing is disabled. Missing
programs, attestor and media credentials produce explicit unavailable states.

Every write route requires a JSON object, same-origin checks, bounded body size, finite
body timeout, per-route rate limit and a shared concurrency cap. Media permits 2,800,000
JSON bytes; ordinary requests permit 32,000. Forwarded Host is ignored. Provider errors
use the media-specific formatter; ordinary errors and nested error/reason strings redact
URLs, authorization and configured credentials. Media disconnects cancel provider work.

## Runtime finding

Bun 1.3.9 automatically destroys IncomingMessage after body completion, clearing native
`onabort` while an upload provider request is still pending. The media route disables
that auto-destroy until response completion on this exact pinned runtime. A raw TCP
disconnect test verifies cancellation; a raw chunked-body test verifies timeout and size
rejection. Requalify this compatibility workaround before changing Bun versions.

Source: https://github.com/oven-sh/bun/blob/bun-v1.3.9/src/js/node/_http_incoming.ts

## Readiness and lifecycle

`/api/health` retains its process-liveness scope. `/api/readiness` retains catalog readiness
and adds separate per-feature configuration/signing/verification indicators. It explicitly
reports `productionReady:false`, unverified provider health and pinned Carbon runtime.
Independent deployment tools are packaged; their profiles cannot silently switch the
baseline launch encoder to a different ABI. Worker completion does not certify RPC health.

The reconciliation worker does not overlap. SIGINT/SIGTERM stop new requests and worker
ticks, drain requests/reconciliation, then close stores. The executable has a 30-second
shutdown deadline. Recovery data persists across restarts.

## Portable package

The exporter pins existing workspace `pngjs` 5.0.0 alongside viem; it rewrites source,
test and optional browser-tool imports. PNG decoding requires this existing library;
native JavaScript has no equivalent PNG decoder, and no workspace dependency installation
is needed. The package contains its MIT license and transitive dependency licenses.

Operations templates, deployment scripts, workstream reports and advanced contract sources
are included. Solidity dependencies are copied by their reachable import graph, not by
copying the upstream workspace. The manifest is generated after install, lockfile and build.
Runtime stores, private environment files, populated owner plans, signer modules and
unrelated upstream state are excluded. Owner and platform-recipient templates stay blank.

## Measured verification — 2026-10-31

- `bun test test/ tools/deployment.test.mjs`: **278 passed, 8 skipped, 0 failed;
  2,112 assertions across 22 files**. The eight default skip entries belong to the
  explicitly opt-in Anvil suite (including its hooks); they are not hidden failures.
- `PLUGGED_PROGRAMS_INTEGRATION=1 bun test test/program-service.integration.test.mjs`:
  **6 passed, 0 failed, 141 assertions** against an isolated local Anvil chain.
- Integrated tests exercise every exact route signature, independent signing gates,
  ungated recovery, shared SQLite identity, actual program contribution/receipt/restart
  recovery against mocked RPC, actual reward/trading validation, actual PNG normalization
  and digest-bound provider CID, secret-safe failures, raw TCP cancellation, streamed size
  and timeout limits, trusted-origin checks, upload rate limits and shutdown/drain ordering.
  External RPC/provider fixtures are test-only; these tests make no live-readiness claim.
- `bun run build`: **265,904 JavaScript bytes** at preview restart. No new workspace
  package or framework was installed. Subsequent parallel frontend changes require a
  fresh frontend build before they can appear in that preview.
- Preliminary portable export `plugged-integration-package-20261031-a`: **320 manifest
  files, 5,461,411 source/artifact bytes**, with existing viem 2.56.0 and pngjs 5.0.0;
  **14 installed packages** in scratch, not the workspace.
- Its clean-install command verified the manifest, installed a frozen lock, ran **266
  application tests passing, 8 opt-in skips, 0 failures**, rebuilt frontend/backend and
  passed release preflight (`deployed:false`). This preliminary count predates the final
  shared-handle and drain tests above. The release refresh includes those later changes.
- Portable `forge build` through WSL compiled **143 files with Solc 0.8.26**, successfully
  in **160.87 seconds**, using only the vendored import closure. Foundry emitted lint
  warnings (including type casts and test transfers); compilation is not an audit verdict.
- `test/platform-api-smoke.mjs` verified **both `server.ts` and `server.bundle.js`** from
  clean extraction with `--no-env-file --no-install`, isolated persistent paths, real
  static files, new read endpoints and disabled signing gates. No provider calls were
  needed. Both processes terminated with **143** on this Windows host, so signal-driven
  graceful exit is **not** claimed; direct drain behavior is separately tested.

## Preview and coordination

Frontend thread 1566125343675519026 received queued notifications when routes worked and
after app restart. The previous listener was verified as the Plugged Bun server before
termination. Only the app was restarted; the bot was not touched. The replacement on
127.0.0.1:4317 reported `startedAt: 2026-10-31T21:16:19.856Z`. HTTP checks confirmed
programs `undeployed`, media `available:false`, and `productionReady:false`. Its previous
`launchEnabled:true` preview setting was preserved; program enablement was not invented.
The frontend owner is responsible for final browser screenshots/CSP/accessibility gates.

## Remaining external gates

1. No production program/splitter deployment, attestor, authorized paid Pinata upload,
   social wallet-control onboarding or mainnet trade/claim was fabricated or broadcast.
2. Independent/advanced contract sources and deployment tooling are portable; they do not
   activate the baseline HTTP launch encoder. That distinct ABI still needs its own runtime
   preparation and receipt integration before activation.
3. Linux signal handling, actual DNS/TLS/service deployment, off-host backups and alert
   delivery remain operator-host verification tasks. The shared store backup now includes
   launch, trade, reward and program tables. An explicit separate program DB and any
   operator cashback index database require separate backup coverage.
4. Live settlement and provider readiness remain unverified even though assembled browser
   gates now pass: the frontend tests intentionally mock active transaction flows and never
   broadcast or upload to a paid provider.

## Completion summary

The HTTP integration and portable export are implemented, with safe boundaries, one shared
LaunchService/SQLite handle, retained recovery, honest readiness and meaningful integrated
tests. Health and graceful-drain behavior were preserved and expanded. Changes remain
uncommitted in the existing branch. Final release-refresh measurements are appended below.

## Final release refresh and frontend result

- Snapshot `C:/Users/shies/AppData/Local/Temp/opencode/plugged-integration-package-20261031-b`:
  **323 manifest files, 5,500,506 bytes**. Clean extraction at sibling
  `plugged-integration-clean-20261031-b` passed frozen install, **267 application tests /
  8 opt-in skip entries / 0 failures / 2,112 assertions**, backend/frontend rebuild and
  release preflight. Separate portable deployment CLI suite: **11 passed, 0 failed**.
- Source and bundled executable smoke both passed again on that final code snapshot;
  Windows termination remained 143. No production/private environment was supplied.
- Frontend owner completed the requested run against the restarted application with the
  exact `startedAt` above: **24 checks, 13 AccessLint states × 94 rules, zero violations,
  zero skips, zero runtime errors, zero captured CSP violations**, and ten refreshed
  screenshots. Its separate launch regression passed **12 checks**. Real unconfigured
  API reads/gates were exercised; active transaction flows use explicit wallet/HTTP mocks.
  The earlier CSP/textarea findings are resolved in the owner's final report.
- Final documentation/browser-test refresh is exported as
  `C:/Users/shies/AppData/Local/Temp/opencode/plugged-integration-package-20261031-c`.
  The exporter excludes installed `node_modules` from its manifest; archive only manifest
  files plus `PACKAGE-MANIFEST.json`, never the scratch installation directory wholesale.
- Scoped Critique successfully rendered the exact ten-file integration diff through stdin,
  but upload failed with **“Unable to connect”**. No review URL was produced. No unrelated
  working-tree files were included. The initial direct filter attempts returned no changes;
  feeding the explicit Git pathspec diff resolved rendering, not the upload connectivity.

All logs and portable verification artifacts are under the approved temporary `opencode`
directory. The source completion record is this file; the parent can collect it without any
broadcast message or commit from this session.

### Final delivery receipt

- Final snapshot **c**: **323 manifest files, 5,502,611 bytes**. Exact final clean install
  repeated the **267 pass / 8 opt-in skips / 0 fail / 2,112 assertion** result, rebuilt
  frontend/backend, and passed release preflight. Both final source/bundle HTTP smokes passed.
- Archive: `C:/Users/shies/AppData/Local/Temp/opencode/plugged-integration-handoff-20261031.zip`
  (**1,350,438 bytes**).
- Archive SHA-256: `2536e8e5c3097e79a76adea8b5a7f1dab6a152c9519e11a5e05b24296970b508`.
- Every archived source/artifact file was rehashed against the tested manifest: **323
  matching files + the manifest, zero extra files**. No `node_modules` is archived.
- Preliminary exports and all five clean-install scratch directories were pruned after
  verification. Final export **c**, its zip and logs remain. The documentation inside the
  archive records the completed code/browser results; this final archive receipt is kept
  outside that immutable archive to avoid self-referential hash changes.
