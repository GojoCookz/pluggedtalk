# Operations workstream handoff

## Implemented scope

Only new `plugged/ops/*`, `plugged/tools/backup*.mjs`, `restore*.mjs`,
`operations*.mjs`, `plugged/test/operations*` and this note were edited. No shared
server/build/export/environment file was edited. No commits, pushes, worktrees,
deployments, installed packages in the workspace, or machine service changes occurred.

The implementation uses existing Bun 1.3.9 and built-in SQLite/node APIs. A local,
dependency-free test fixture package is created and removed in the OS temporary
`opencode` directory to exercise frozen installation; it is not a product dependency.

## Parent integration: exact changes needed

1. **Exporter:** add `ops` to the directory allowlist in `tools/package-handoff.mjs`.
   Existing `tools` and `test` copying includes all operation scripts/tests automatically.
   Optionally include this note. Include `ops/README.md` in the handoff index. All these
   files are UTF-8 source/templates; no extra rewrite or package dependency is needed.
2. **Manifest:** generate the final `PACKAGE-MANIFEST.json` after copying `ops`, generating
   `bun.lock`, and rebuilding `server.bundle.js`/`dist`. The clean-install command verifies
   every manifest entry before copying to a fresh directory and refuses a missing lockfile.
   Do not include `node_modules`, runtime, backups, private `.env` files, real deployment
   owner records, keystores, private keys or populated service/secrets files. Keep the
   ownership example's `ownerAddress` and `platformRecipientAddress` empty.
3. **Backend build:** retain `server.bundle.js` beside `dist/` in the portable root. The
   service template invokes this bundle directly, with `--no-env-file --no-install`.
   Relative data/static paths and `import.meta.main` must work in the bundle. Test that
   exact entrypoint after integrating the server lifecycle changes below.
4. **Environment documentation:** add `PLUGGED_PUBLIC_ORIGIN` (real HTTPS origin; used
   by preflight/health), `PLUGGED_BACKUP_DIR` (absolute existing private directory;
   used by backup job). Keep `PORT=4317`, production `PLUGGED_DB_PATH` outside the release,
   explicit `PLUGGED_LAUNCH_ENABLED`, and `PLUGGED_RPC_URL`. The ops-only variables need
   not be consumed by `server.ts`. Hosting never needs a wallet signing key. Production
   templates separate `/etc/plugged/service.env` from `/etc/plugged/secrets.env` and
   disable automatic dotenv loading.
5. **Server lifecycle, owned by parent:** keep 127.0.0.1:4317; catch reconciliation
   errors; retain the interval handle; prevent overlap; implement SIGTERM/SIGINT drain
   that stops new requests/worker runs, waits for in-flight operations, closes stores,
   and exits within 30 seconds. Unit permits 45 seconds. Test both source and bundle.
   The server read at workstream start had no signal/drain handler; this workstream
   does not claim that has been fixed by its templates. Parent may implement concurrently.
6. **Operational health:** the executable probe currently uses `/api/config` with
   `network.id===4663` and `/api/readiness` with `chainId===4663` and boolean `ready`.
   Availability and full-catalog readiness are reported separately. These endpoints
   do not establish DB, RPC or reconciliation-worker health. For deeper monitoring,
   add a separate safe endpoint exposing local DB read/draining/last-success status,
   then integrate it with the monitor. Do not replace catalog readiness with an always-
   true process indicator. Existing pending approvals should not be called downtime.
7. **Other writers/stores:** launch backup includes every table in its SQLite file,
   including future rewards tables in that file. It explicitly requires the `launches`
   schema; it is not an automatic backup of separate SQLite files or uploaded media.
   Parent must inventory agent-added stores and configure their backup procedures.
   Put media and other writable paths below `/var/lib/plugged` for service sandbox
   compatibility. The release directory is read-only under the unit.
8. **Runtime pin:** operations preflight pins Bun **1.3.9** exactly (the installed/tested
   version), stricter than the exporter's current `>=1.3.9` engine declaration. Align
   package guidance with the tested pin or explicitly requalify a newer version.

## Commands for parent/package validation

Run from `plugged/`:

```sh
bun test test/operations.test.mjs test/operations-config.test.mjs
```

Run from the finished portable package, not the source workspace:

```sh
bun --no-env-file tools/operations-clean-install.mjs \
  --source /absolute/extracted-release --work /absolute/new-validation-directory

bun --no-env-file --no-install tools/operations-preflight.mjs --mode release
```

With the production environment injected and persistent directory provisioned:

```sh
bun --no-env-file --no-install tools/operations-preflight.mjs --mode production
```

This last command validates local configuration only; it starts no process/service and
returns `deployed:false`. The unit runs it as `ExecStartPre`. An unconfigured production
template intentionally fails the real-origin/RPC checks.

## Backup/restore contract

- Backup: `bun tools/backup-sqlite.mjs --source DATABASE --out NEW_DIRECTORY`.
- Verify: `bun tools/restore-sqlite.mjs --verify BACKUP_DIRECTORY`.
- Restore: `bun tools/restore-sqlite.mjs --backup BACKUP_DIRECTORY --destination NEW_FILE`.
- Scheduled runner: `bun tools/operations-backup-job.mjs`; uses the two absolute path
  environment variables, produces a unique backup, verifies an actual restore, and
  reports `offHostCopied:false` until an operator implements separate off-host copy.
- `VACUUM INTO` is the SQLite-documented live-backup alternative to the C backup API,
  which Bun does not expose. It captures committed WAL data without copying/checkpointing
  the live file. Source and resulting snapshot both receive integrity checks.
- SHA-256/size/metadata are checked before restore; staging copy is rehashed; exclusive
  hard-link publication refuses overwrite. Existing DB, empty file and orphan WAL/SHM/
  journal all block restore. There is no destructive/force restore mode.
- Backup bundles are private runtime data. Do not package them for Merc. Checksums are
  corruption detection, not signatures. Only restore from trusted, verified storage.

## Verification evidence

Final verification on Windows, Bun 1.3.9: targeted suite passed **12 tests, 102 assertions,
zero failures in 2.18 seconds**, plus the nested clean-install fixture's **1 test,
1 assertion**. This run includes scratch-path cleanup and removal of an unused API branch.

Tests exercise real `LaunchStore` SQLite databases, not mocked storage:

- Open WAL database with prepared/submitted/confirmed rows, an extra table and a large
  decimal string; restored data matches while the source connection remains open.
- Committed WAL-only data is included; uncommitted writer transaction is excluded.
- Source remains writable after backup, and later commits do not alter the snapshot.
- Restored database reopens through `LaunchStore` and accepts writes.
- CLI child process backs up a DB held open by the test process, verifies and restores it.
- Existing source/destination/empty file and orphan sidecars are never overwritten.
- Corrupt/wrong-schema/missing source, foreign-key corruption, checksum tampering and
  stray backup sidecars fail closed before publishing a destination.
- Scheduled backup runner completes an actual restore drill.
- Production preflight rejects missing artifacts, private release state, unsafe DB
  placement, placeholder origin, absent RPC and signing credentials without logging values.
- HTTP health distinguishes availability from catalog readiness; failures/bad JSON/wrong
  chain are rejected. These health tests use controlled HTTP responses, not a live host.
- Clean-install executes real frozen Bun install, nested tests and build in a fresh
  fixture directory; no network package is required. Tampering and reuse are rejected.

Initial test failures were fixed: Windows fsync needs a writable file descriptor; Bun
removes empty lockfiles, so the clean-install fixture now uses a generated frozen lock
with one temporary local fixture dependency. The final suite, not those intermediate
failures, is the correctness result. The shell harness printed an unrelated PowerShell
`export` preamble error before commands; Bun itself executed and returned the shown
test results. No bot/service configuration was changed to address that harness issue.

## Remaining deployment gates (not live)

- Parent must run clean-install on its **final full portable export**. This workstream
  tested the clean-install command end-to-end on a local fixture, not the concurrent
  agents' unfinished full release.
- Linux systemd/Caddy template validation, actual public DNS/TLS, configured host/domain,
  real upstream checks, shutdown/drain integration, off-host backups, measured recovery
  time and alert delivery have not been exercised here.
- Templates and runbook are in `ops/README.md`; no unit was installed/enabled/restarted.
- A scoped Critique diff rendered successfully, but upload failed with “Unable to
  connect”; no review URL was produced. This does not affect the passing tests above.

Sources: https://www.sqlite.org/lang_vacuum.html and https://bun.sh/docs/api/sqlite
