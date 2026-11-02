import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchStore } from '../lib/launch-store.mjs';
import { backupDatabase } from '../tools/backup-sqlite.mjs';
import { restoreDatabase, verifyBackup } from '../tools/restore-sqlite.mjs';
import { backupJob } from '../tools/operations-backup-job.mjs';

function fixture() {
  const temporary = join(tmpdir(), 'opencode'); mkdirSync(temporary, { recursive: true });
  const dir = mkdtempSync(join(temporary, 'plugged-operations-'));
  const source = join(dir, 'launches.sqlite');
  const store = new LaunchStore(source);
  store.db.exec('PRAGMA wal_autocheckpoint=0;');
  const save = (id, status = 'submitted') => store.save({ id, fingerprint: id, status, createdAt: Date.now(), txHash: '0x' + id });
  return { dir, source, store, save, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test('live WAL LaunchStore backup captures committed rows and restores every table with source still open', async () => {
  const f = fixture();
  try {
    f.save('prepared', 'prepared'); f.save('submitted'); f.save('confirmed', 'confirmed');
    f.store.db.exec("CREATE TABLE extra_state (key TEXT PRIMARY KEY, value TEXT); INSERT INTO extra_state VALUES ('reward', '12345678901234567890');");
    expect(statSync(f.source + '-wal').size).toBeGreaterThan(0);
    const result = await backupDatabase({ source: f.source, out: join(f.dir, 'backup') });
    expect(result.sourceJournalMode).toBe('wal'); expect(result.sourceWalPresent).toBe(true);
    expect(result.snapshot.launches).toBe(3);
    f.save('after-backup');
    const restored = join(f.dir, 'restored.sqlite');
    await restoreDatabase({ backup: join(f.dir, 'backup'), destination: restored });
    const reader = new LaunchStore(restored);
    try {
      expect(reader.get('confirmed')).toEqual(f.store.get('confirmed'));
      expect(reader.get('submitted')).toEqual(f.store.get('submitted'));
      expect(reader.get('after-backup')).toBeNull();
      expect(reader.db.query('SELECT value FROM extra_state').get().value).toBe('12345678901234567890');
      reader.save({ id: 'new', fingerprint: 'new', status: 'prepared', createdAt: 1 });
      expect(reader.get('new').id).toBe('new');
    } finally { reader.close(); }
    expect(f.store.get('after-backup').id).toBe('after-backup');
  } finally { f.cleanup(); }
});
test('uncommitted WAL transaction is excluded without blocking or modifying writer', async () => {
  const f = fixture();
  try {
    f.save('committed'); f.store.db.exec('BEGIN IMMEDIATE'); f.save('uncommitted');
    try {
      const result = await backupDatabase({ source: f.source, out: join(f.dir, 'snapshot') });
      expect(result.snapshot.launches).toBe(1);
      expect(f.store.get('uncommitted').id).toBe('uncommitted');
    } finally { f.store.db.exec('ROLLBACK'); }
    expect(f.store.get('uncommitted')).toBeNull();
  } finally { f.cleanup(); }
});
test('never overwrites source, an empty destination, backup directory or orphan sidecar', async () => {
  const f = fixture();
  try {
    f.save('safe'); const backup = join(f.dir, 'backup'); await backupDatabase({ source: f.source, out: backup });
    await expect(backupDatabase({ source: f.source, out: backup })).rejects.toThrow();
    await expect(restoreDatabase({ backup, destination: f.source })).rejects.toThrow('Refusing overwrite');
    const empty = join(f.dir, 'empty.sqlite'); writeFileSync(empty, '');
    await expect(restoreDatabase({ backup, destination: empty })).rejects.toThrow('Refusing overwrite');
    expect(statSync(empty).size).toBe(0);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const destination = join(f.dir, 'orphan' + suffix + '.sqlite'); writeFileSync(destination + suffix, 'keep');
      await expect(restoreDatabase({ backup, destination })).rejects.toThrow('Refusing overwrite');
      expect(readFileSync(destination + suffix, 'utf8')).toBe('keep'); expect(existsSync(destination)).toBe(false);
    }
  } finally { f.cleanup(); }
});
test('rejects corrupt source, wrong application schema, tampered backup and stray WAL', async () => {
  const f = fixture();
  try {
    const bad = join(f.dir, 'bad.sqlite'); writeFileSync(bad, 'not SQLite');
    await expect(backupDatabase({ source: bad, out: join(f.dir, 'bad-backup') })).rejects.toThrow();
    expect(existsSync(join(f.dir, 'bad-backup'))).toBe(false);
    const unrelated = join(f.dir, 'unrelated.sqlite'); const db = new Database(unrelated); db.exec('CREATE TABLE other (id TEXT)'); db.close();
    await expect(backupDatabase({ source: unrelated, out: join(f.dir, 'wrong') })).rejects.toThrow('compatible Plugged');
    const backup = join(f.dir, 'backup'); await backupDatabase({ source: f.source, out: backup });
    writeFileSync(join(backup, 'database.sqlite-wal'), 'stray');
    await expect(verifyBackup(backup)).rejects.toThrow('sidecar'); rmSync(join(backup, 'database.sqlite-wal'));
    const bytes = readFileSync(join(backup, 'database.sqlite')); bytes[100] ^= 0xff; writeFileSync(join(backup, 'database.sqlite'), bytes);
    await expect(restoreDatabase({ backup, destination: join(f.dir, 'never.sqlite') })).rejects.toThrow('SHA-256');
    expect(existsSync(join(f.dir, 'never.sqlite'))).toBe(false);
  } finally { f.cleanup(); }
});
test('CLI round trip operates against a database held open in another process', async () => {
  const f = fixture();
  try {
    f.save('cli'); const backup = join(f.dir, 'cli-backup');
    for (const args of [
      ['backup-sqlite.mjs', '--source', f.source, '--out', backup],
      ['restore-sqlite.mjs', '--verify', backup],
      ['restore-sqlite.mjs', '--backup', backup, '--destination', join(f.dir, 'cli-restored.sqlite')],
    ]) {
      const run = Bun.spawn([process.execPath, new URL('../tools/' + args[0], import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args.slice(1)], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exit] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' }); expect(JSON.parse(stdout).ok).toBe(true);
    }
    expect(f.store.get('cli').id).toBe('cli');
  } finally { f.cleanup(); }
});
test('scheduled job verifies a real restore before reporting success', async () => {
  const f = fixture();
  try {
    f.save('scheduled');
    const result = await backupJob({ PLUGGED_DB_PATH: f.source, PLUGGED_BACKUP_DIR: f.dir });
    expect(result.restoreVerified).toBe(true); expect(result.offHostCopied).toBe(false);
    expect((await verifyBackup(result.backup)).manifest.snapshot.launches).toBe(1);
  } finally { f.cleanup(); }
});
test('source foreign-key corruption and missing source are rejected before publication', async () => {
  const f = fixture();
  try {
    f.store.db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE parents (id INTEGER PRIMARY KEY); CREATE TABLE children (parent INTEGER REFERENCES parents(id)); INSERT INTO children VALUES (9);');
    await expect(backupDatabase({ source: f.source, out: join(f.dir, 'invalid') })).rejects.toThrow('foreign_key_check');
    expect(existsSync(join(f.dir, 'invalid'))).toBe(false);
    await expect(backupDatabase({ source: join(f.dir, 'missing'), out: join(f.dir, 'missing-backup') })).rejects.toThrow();
    expect(existsSync(join(f.dir, 'missing'))).toBe(false);
  } finally { f.cleanup(); }
});
