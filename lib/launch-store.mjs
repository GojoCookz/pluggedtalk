import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class LaunchStore {
  constructor(path) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new Database(path,{create:true});
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS launches (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL,
        created INTEGER NOT NULL, tx_hash TEXT UNIQUE, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS confirmed_identity ON launches(fingerprint) WHERE status='confirmed';
      CREATE INDEX IF NOT EXISTS launch_status ON launches(status,created);
      CREATE INDEX IF NOT EXISTS launch_token ON launches(lower(json_extract(data,'$.token'))) WHERE status='confirmed';`);
  }
  confirmedByToken(token,engine='carbon-baseline-v1') {
    if(typeof token!=='string')return null;
    const row=this.db.query("SELECT data FROM launches WHERE status='confirmed' AND lower(json_extract(data,'$.token'))=? AND coalesce(json_extract(data,'$.engine'),'carbon-baseline-v1')=? LIMIT 1").get(token.toLowerCase(),engine);
    return row?JSON.parse(row.data):null;
  }
  byCreator(account,limit=50) {
    if(typeof account!=='string')return [];
    return this.db.query("SELECT data FROM launches WHERE status='confirmed' AND lower(json_extract(data,'$.input.account'))=? AND coalesce(json_extract(data,'$.engine'),'carbon-baseline-v1')='carbon-baseline-v1' ORDER BY created DESC LIMIT ?").all(account.toLowerCase(),limit).map(r=>JSON.parse(r.data));
  }
  get(id) { const row=this.db.query('SELECT data FROM launches WHERE id=?').get(id);return row?JSON.parse(row.data):null; }
  duplicate(key) {return this.db.query("SELECT id FROM launches WHERE fingerprint=? AND status='confirmed'").get(key)?.id;}
  save(record) {
    this.db.query(`INSERT INTO launches VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      status=excluded.status,tx_hash=excluded.tx_hash,data=excluded.data`).run(record.id,record.fingerprint,record.status,record.createdAt,record.txHash??null,JSON.stringify(record));
    return record;
  }
  // Records without an engine tag are the original Carbon baseline. Engines never share listings.
  list(status,limit=100,engine='carbon-baseline-v1') {return this.db.query("SELECT data FROM launches WHERE status=? AND coalesce(json_extract(data,'$.engine'),'carbon-baseline-v1')=? ORDER BY created DESC LIMIT ?").all(status,engine,limit).map(r=>JSON.parse(r.data));}
  // Reconciliation walks least-recently-checked first so old submissions are never starved by new ones.
  listForReconcile(status,limit=20,engine='carbon-baseline-v1') {return this.db.query("SELECT data FROM launches WHERE status=? AND coalesce(json_extract(data,'$.engine'),'carbon-baseline-v1')=? ORDER BY coalesce(json_extract(data,'$.checkedAt'),0) ASC, created ASC LIMIT ?").all(status,engine,limit).map(r=>JSON.parse(r.data));}
  checked(id,at) {this.db.query("UPDATE launches SET data=json_set(data,'$.checkedAt',?) WHERE id=?").run(at,id);}
  prune(now) {this.db.query("DELETE FROM launches WHERE status='prepared' AND created<?").run(now-86400000);}
  close() {this.db.close();}
}
