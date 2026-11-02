import { mkdtempSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { backupDatabase } from './backup-sqlite.mjs';
import { restoreDatabase } from './restore-sqlite.mjs';
import { cli } from './operations-sqlite.mjs';

export async function backupJob(env = process.env) {
  const directory = env.PLUGGED_BACKUP_DIR, source = env.PLUGGED_DB_PATH;
  if (!directory || !source || !isAbsolute(directory) || !isAbsolute(source)) throw new Error('Absolute PLUGGED_BACKUP_DIR and PLUGGED_DB_PATH are required.');
  const out = join(directory, new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID());
  const result = await backupDatabase({ source, out });
  const drill = mkdtempSync(join(directory, '.restore-drill-'));
  try {
    await restoreDatabase({ backup: out, destination: join(drill, 'verified.sqlite') });
    return { ok: true, backup: out, sha256: result.sha256, createdAt: result.createdAt, restoreVerified: true, offHostCopied: false };
  } finally { rmSync(drill, { recursive: true, force: true }); }
}
if (import.meta.main) await cli(() => backupJob());
