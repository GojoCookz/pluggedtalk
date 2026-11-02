import { constants, copyFileSync, chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { argumentsFor, cli, inspectDatabase, regular, exists, refuseExisting, sha256, syncFile, syncDirectory } from './operations-sqlite.mjs';

export async function verifyBackup(backup) {
  const directory = resolve(backup), database = join(directory, 'database.sqlite');
  regular(database); regular(join(directory, 'manifest.json'));
  for (const suffix of ['-wal', '-shm', '-journal']) if (exists(database + suffix)) throw new Error('Backup must be standalone; unexpected SQLite sidecar.');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'plugged-sqlite-backup-v1' || manifest.sourceIntegrity !== 'ok' ||
      !/^[0-9a-f]{64}$/.test(manifest.sha256) || manifest.bytes !== statSync(database).size ||
      manifest.sha256 !== await sha256(database)) throw new Error('Backup manifest or SHA-256 mismatch.');
  const snapshot = inspectDatabase(database);
  if (JSON.stringify(snapshot) !== JSON.stringify(manifest.snapshot)) throw new Error('Backup database metadata mismatch.');
  return { database, manifest };
}
export async function restoreDatabase({ backup, destination }) {
  if (!backup || !destination) throw new Error('Usage: bun tools/restore-sqlite.mjs --backup BACKUP_DIRECTORY --destination NEW_DATABASE');
  destination = resolve(destination);
  refuseExisting(destination);
  const { database, manifest } = await verifyBackup(backup);
  const staging = mkdtempSync(join(dirname(destination), '.plugged-restore-'));
  try {
    chmodSync(staging, 0o700);
    const candidate = join(staging, 'database.sqlite');
    copyFileSync(database, candidate, constants.COPYFILE_EXCL); chmodSync(candidate, 0o600);
    if (await sha256(candidate) !== manifest.sha256) throw new Error('Restore copy SHA-256 mismatch.');
    const snapshot = inspectDatabase(candidate);
    syncFile(candidate);
    refuseExisting(destination);
    // Same-filesystem hard link publishes atomically and fails if destination appeared.
    linkSync(candidate, destination);
    syncDirectory(dirname(destination));
    return { ok: true, destination, sha256: manifest.sha256, snapshot, activated: false };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
if (import.meta.main) await cli(async () => {
  const args = argumentsFor(process.argv.slice(2), ['--backup', '--destination', '--verify']);
  if (args['--verify']) {
    if (args['--backup'] || args['--destination']) throw new Error('Use --verify alone.');
    const { manifest } = await verifyBackup(args['--verify']); return { ok: true, verified: true, ...manifest };
  }
  return restoreDatabase({ backup: args['--backup'], destination: args['--destination'] });
});
