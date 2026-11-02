import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, openSync, closeSync, fsyncSync } from 'node:fs';

export function exists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export function regular(path) {
  if (!lstatSync(path).isFile()) throw new Error('Expected a regular file (no symlinks).');
}
export function refuseExisting(path) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    if (exists(path + suffix)) throw new Error('Refusing overwrite: destination or SQLite sidecar already exists.');
  }
}
export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function syncFile(path) {
  const fd = openSync(path, process.platform === 'win32' ? 'r+' : 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function syncDirectory(path) {
  // Windows does not expose directory fsync through node:fs. Linux deployment does.
  if (process.platform !== 'win32') syncFile(path);
}
export function inspectDatabase(path) {
  regular(path);
  const db = new Database(path, { readonly: true, create: false });
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; BEGIN;');
    const integrity = db.query('PRAGMA integrity_check').values();
    if (integrity.length !== 1 || integrity[0][0] !== 'ok') throw new Error('SQLite integrity_check failed.');
    if (db.query('PRAGMA foreign_key_check').all().length) throw new Error('SQLite foreign_key_check failed.');
    const columns = db.query('PRAGMA table_info(launches)').all().map(row => row.name);
    if (!['id', 'fingerprint', 'status', 'created', 'tx_hash', 'data'].every(name => columns.includes(name))) {
      throw new Error('Not a compatible Plugged launches database.');
    }
    const result = {
      integrity: 'ok',
      journalMode: db.query('PRAGMA journal_mode').values()[0][0],
      userVersion: db.query('PRAGMA user_version').values()[0][0],
      launches: db.query('SELECT count(*) AS count FROM launches').get().count,
      tables: db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name),
    };
    db.exec('ROLLBACK');
    return result;
  } finally { db.close(); }
}
export function argumentsFor(argv, allowed) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!allowed.includes(name) || result[name] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error(`Expected named arguments: ${allowed.join(', ')}`);
    }
    result[name] = argv[i + 1];
  }
  return result;
}
export async function cli(action) {
  try { console.log(JSON.stringify(await action(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
