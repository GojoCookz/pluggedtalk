import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { argumentsFor, cli, inspectDatabase, exists, sha256, syncFile, syncDirectory } from './operations-sqlite.mjs';

// VACUUM INTO is SQLite's transactional live-backup alternative to its C backup API.
// Never copy the live database file: committed transactions can still be in its WAL.
export async function backupDatabase({ source, out }) {
  if (!source || !out) throw new Error('Usage: bun tools/backup-sqlite.mjs --source DATABASE --out NEW_BACKUP_DIRECTORY');
  source = resolve(source); out = resolve(out);
  const before = inspectDatabase(source);
  const walPresent = exists(source + '-wal');
  mkdirSync(out, { mode: 0o700 }); // Exclusive ownership; never reuse an old backup directory.
  try {
    const partial = join(out, 'database.partial');
    const db = new Database(source, { readonly: true, create: false });
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL;');
      db.query('VACUUM main INTO ?').run(partial);
    } finally { db.close(); }
    chmodSync(partial, 0o600);
    const snapshot = inspectDatabase(partial);
    syncFile(partial);
    const manifest = {
      format: 'plugged-sqlite-backup-v1', createdAt: new Date().toISOString(),
      method: 'sqlite-vacuum-into', sourceIntegrity: before.integrity,
      sourceJournalMode: before.journalMode, sourceWalPresent: walPresent,
      snapshot, bytes: statSync(partial).size, sha256: await sha256(partial),
    };
    renameSync(partial, join(out, 'database.sqlite'));
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    syncFile(join(out, 'manifest.json'));
    syncDirectory(out); syncDirectory(dirname(out));
    return { ok: true, backup: out, ...manifest };
  } catch (error) { rmSync(out, { recursive: true, force: true }); throw error; }
}
if (import.meta.main) await cli(() => {
  const args = argumentsFor(process.argv.slice(2), ['--source', '--out']);
  return backupDatabase({ source: args['--source'] ?? process.env.PLUGGED_DB_PATH, out: args['--out'] });
});
