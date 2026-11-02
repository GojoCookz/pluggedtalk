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
      CREATE INDEX IF NOT EXISTS launch_status ON launches(status,created);`);
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
  prune(now) {this.db.query("DELETE FROM launches WHERE status='prepared' AND created<?").run(now-86400000);}
  close() {this.db.close();}
}
