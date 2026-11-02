# Plugged production operations

These are uninstalled templates and executable checks, not a live deployment. A real
host, domain, DNS, HTTPS certificate, RPC configuration, alert destination and operator
are still required. No service, proxy or machine configuration is changed by these tools.
The validated runtime is **Bun 1.3.9**. No new application dependency is required.

## 1. Layout and isolation

```text
Internet :443 → Caddy → 127.0.0.1:4317 → one Bun process
                                           │
                            /var/lib/plugged/launches.sqlite (+ WAL/SHM)
                                           │
                            /var/backups/plugged/<unique backup>/
                                           │
                            encrypted off-host storage, separate credentials

/opt/plugged/releases/<release-id>/     immutable exported package
/opt/plugged/current                   operator-selected release symlink
/opt/bun/bin/bun                       pinned, operator-installed Bun binary
/etc/plugged/service.env               nonsecret runtime configuration
/etc/plugged/secrets.env               RPC/API credentials, outside release
```

Use a dedicated unprivileged `plugged` account, one process per database, persistent
local storage (not a network filesystem for SQLite WAL), and an independently managed
Caddy service. Permit public 80/443; do not expose 4317. Do not run cluster workers.
Release files must be root-owned and not writable by the application. Provision
`/var/lib/plugged` and `/var/backups/plugged` owned by `plugged`, mode 0700.
`StateDirectory=plugged` also creates the state directory on service start.

Copy example environment files to `/etc/plugged`, never into a release. Use
root:plugged 0640 for `service.env`, root:root 0600 for `secrets.env`; systemd reads
both before dropping privileges. Templates contain no operational credentials or
ownership choices. Configure Caddy's domain/email in its own environment. The Bun
unit disables automatic dotenv loading and runtime dependency installation.
Keep all additional writable stores (including uploaded media) under `/var/lib/plugged`
and configure their application paths explicitly before enabling those features.

## 2. Clean-install and deployment preflight

Run from an extracted **portable release**, using the pinned Bun executable. This
copies only hash-verified manifest files into a new directory, performs a frozen
install with lifecycle scripts disabled, runs application tests, rebuilds, and checks
required release files. It starts no server and changes no host services.

```sh
bun --no-env-file tools/operations-clean-install.mjs \
  --source /path/to/extracted-release --work /path/to/new-clean-validation
```

The destination's parent must exist. The command refuses an existing destination,
missing lockfile, hash mismatch, traversal, symlinked files, private paths and local
runtime state. An error leaves the scratch directory for diagnosis; choose a new
directory on retry. Use only a trusted release: its tests/build are executable code.
Manifest hashes detect alteration, not authorship; verify the archive's independently
delivered checksum before extraction. Clean-install isolates application credentials
from child commands. It uses the existing locked dependency versions, not upgrades.

Read-only release check (works without installing dependencies):

```sh
bun --no-env-file --no-install tools/operations-preflight.mjs --mode release
```

Once the operator has provisioned the runtime paths and environment, run as the service
account with the same environment that systemd will inject:

```sh
bun --no-env-file --no-install tools/operations-preflight.mjs --mode production
```

`plugged.service` runs that production check automatically before starting. It requires
production mode, port 4317, explicit launch flag, real HTTPS origin, HTTPS RPC, external
writable absolute DB path, no signing credentials and all packaged artifacts. It does
not contact RPC, validate DNS/TLS, inspect contract ownership, verify shutdown behavior,
or claim that deployment is live. `deployed` is always false in preflight output.

Before installing units, the host operator must validate templates using their installed
versions of `systemd-analyze verify` and `caddy validate --config ... --adapter caddyfile`.
This Windows workstream has not validated those Linux binaries. Set a real DNS name,
confirm A/AAAA routing and firewall rules, and verify ACME issuance. The proxy preserves
the public Host and Origin relationship required by same-origin POST validation. It
never serves the release directory directly. Review log retention and redact query
strings if adding routes that could include private input in URLs.

The release owner must test the actual bundled server's SIGTERM/drain behavior before
production activation; see section 5. After operator-authorized start, verify:

```sh
bun --no-env-file tools/operations-health.mjs --url http://127.0.0.1:4317
bun --no-env-file tools/operations-health.mjs --url https://YOUR_REAL_DOMAIN
```

Repeat the HTTPS probe from an independent host. Verify chain ID 4663 against the
configured RPC, exact deployed contract addresses/code hashes, a fresh pair manifest,
correct ownership/recipients and the selected enabled features. Separately confirm
wallet connection and read-only transaction preparation through the public domain.
No monitoring script signs or broadcasts a transaction.

## 3. Consistent backups and restore verification

```sh
bun --no-env-file tools/backup-sqlite.mjs \
  --source /var/lib/plugged/launches.sqlite \
  --out /var/backups/plugged/NEW_UNIQUE_DIRECTORY

bun --no-env-file tools/restore-sqlite.mjs \
  --verify /var/backups/plugged/NEW_UNIQUE_DIRECTORY

bun --no-env-file tools/restore-sqlite.mjs \
  --backup /var/backups/plugged/NEW_UNIQUE_DIRECTORY \
  --destination /var/lib/plugged/restore-drill-UNIQUE.sqlite
```

Backup opens the source read-only and runs SQLite `integrity_check`, `foreign_key_check`
and a Plugged schema check. SQLite `VACUUM INTO` then produces a transactionally
consistent snapshot of **all tables**, including committed transactions still in WAL.
It does not checkpoint or copy the live main file. Bun's SQLite API does not expose the
C online-backup API; `VACUUM INTO` is SQLite's documented live-backup alternative.
It can consume substantial I/O/CPU and is not incremental. Implicit rowids may change;
application identity must use explicit keys. Source validation and snapshot are separate
read transactions: writes committed between them may be included. The snapshot itself
is verified again, so its manifest describes that snapshot, not a guessed source count.

The output contains `database.sqlite` and `manifest.json` with SHA-256, size, timestamp,
source WAL/journal observations, integrity result, table names and launch count. No
source path or credentials are stored in the manifest. The database contains private
operational data and **must never enter the Merc archive or a public artifact**. Files
are 0600 and bundle directory 0700 on POSIX; Windows requires equivalent directory ACLs.
The database and manifest are fsynced before success; parent directories are fsynced on
Linux. Incomplete/crashed bundles without a valid manifest are not restorable backups.

Scope is the database containing the `launches` table and every other table in that same
file. Separate rewards databases, uploaded media and external configuration are not
included. Inventory those stores and define their own consistent backup/restore procedure
before enabling them; a successful launch-database backup does not protect other files.

Restore verifies hash/size/integrity/schema, copies to a private same-filesystem staging
directory, checks the copy, fsyncs it, then publishes with an exclusive hard link.
It refuses any existing destination, even an empty file, and refuses existing WAL/SHM/
journal sidecars. There is no `--force`. The destination parent must exist on a local
filesystem supporting hard links. Use operator-owned directories with no competing
process opening the new path. It never activates the restored database or stops a
service. If publication succeeded but directory fsync failed, a valid destination may
remain despite a nonzero exit; inspect it and choose another path, never overwrite it.

`operations-backup-job.mjs` reads `PLUGGED_DB_PATH` and `PLUGGED_BACKUP_DIR`, creates a
unique backup, performs a real restore drill, removes only its drill copy, then reports
`restoreVerified:true`. The hourly timer adds up to 60 seconds of jitter. **No pruning or
off-host transfer is automatic.** An on-disk backup alone is not disaster recovery.
Operators must configure encrypted off-host copy with independent credentials, verify
the remote checksum, and retain at least 24 hourly, 14 daily and 8 weekly verified copies
subject to their data-retention policy. Do not prune the last verified off-host backup.
Suggested targets: RPO ≤ 2 hours including off-host copy; RTO ≤ 30 minutes. These are
targets, not measured production guarantees. Rehearse a timed off-host restore monthly.

Never copy just `launches.sqlite` while it is open. Never delete a live `-wal` or `-shm`.
Preserve the original database and its sidecars together during incident recovery.

## 4. Monitoring and incident response

`operations-health.mjs` exits 0 when `/api/config` and `/api/readiness` return valid
Plugged responses on chain 4663. It uses bounded requests and rejects redirects.
`live` means only HTTP availability; `ready` preserves the application's separate
catalog readiness result. Pending pair approvals may make `ready:false` while the
service and approved-pair flow work. Use `--require-ready true` only when full-catalog
readiness is the intended gate. A 200 response alone is insufficient.

The optional health timer records results in journald. It is **not an alert delivery
system**. Wire failed units/results to the operator's existing monitoring destination
and add an independent external HTTPS check before calling monitoring active.

Alert thresholds to configure:

- Three failed HTTPS probes in a row; certificate expires within 14 days.
- Backup or restore-drill failure immediately; no verified off-host backup for 2 hours.
- Disk under 20% free or insufficient space for two database copies plus normal WAL growth.
- WAL remains above 256 MiB for 15 minutes, repeated SQLITE_BUSY, unexpected restarts,
  reconciliation errors, or submitted records remain unprocessed across several blocks.
- Full-catalog blockers and feature disablement are product-state alerts, separate from
  HTTP downtime. Readiness snapshots do not prove RPC, storage or worker health.

Triage with `systemctl status plugged`, `journalctl -u plugged --since '-15 minutes'`,
`journalctl -u plugged-backup`, disk space and both local/external probes. These are
operator commands; none are executed by this repository tooling. Logs must not contain
RPC credentials, wallet secrets, raw submitted bodies or complete sensitive headers.

Incident sequence:

1. Record UTC time, release ID, symptoms, last successful backup and affected features.
   If transaction preparation is unsafe, disable the relevant operator flags and use
   the documented graceful restart; keep transaction recovery/status accessible where possible.
2. Distinguish proxy/DNS/TLS failure (local probe works) from Bun failure (local probe
   fails), RPC/provider outage, disk exhaustion and SQLite failure. Do not relaunch a
   wallet transaction merely because a browser request timed out.
3. On SQLite corruption, stop writers through the approved shutdown procedure, preserve
   the original DB plus all sidecars, and identify a verified off-host backup. The backup
   command deliberately refuses corrupt input; never label a forensic file copy a good backup.
4. Restore to a **new filename**, verify launch records, then change `PLUGGED_DB_PATH`
   while the old service is stopped. Do not overwrite the original. Start one instance,
   verify reads and reconciliation, then recover missing broadcast hashes through the
   existing submit/recovery flow. Restoring SQLite does not reverse on-chain transactions.
5. For code rollback, point at a known-good immutable release only after checking schema
   compatibility. Preserve the current DB; do not blindly restore an old DB to roll back code.
6. Confirm external HTTPS, DB/worker health, fresh off-host backup and affected workflows.
   Document actual RPO/RTO and cause; clear the incident only after evidence is recorded.

## 5. Graceful server requirements (parent integration)

The service template sends SIGTERM and allows 45 seconds before systemd kills remaining
processes. This template does not add application signal handlers. Production server
must implement and test all of the following in its source and bundled entrypoint:

- Validate configuration at startup; bind **127.0.0.1:4317**, never wildcard interfaces.
- On SIGTERM/SIGINT: mark draining, stop accepting new requests, clear reconciliation
  intervals and prevent new worker runs, await current requests and worker completion.
- Catch and report worker promise failures; prevent overlapping reconciliation calls.
- Close each database exactly once after writes complete. A checkpoint may be attempted
  after draining; a busy checkpoint is not permission to remove WAL files.
- Bound draining to 30 seconds, log completion without secrets, then exit. A forced exit
  must remain recoverable by SQLite WAL and transaction reconciliation after restart.
- Expose a distinct operational health endpoint if DB and worker monitoring is needed:
  no secrets, no public wallet data, local DB read result, draining flag and last successful
  worker time. Do not claim a static readiness snapshot proves these conditions.

## References

- SQLite transactional live snapshots: https://www.sqlite.org/lang_vacuum.html
- Bun SQLite API: https://bun.sh/docs/api/sqlite
- Caddy reverse proxy: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- systemd service lifecycle: https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
