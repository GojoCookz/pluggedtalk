import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class ProgramStore {
  constructor(source) {
    this.ownsDatabase=typeof source==='string';
    if(!this.ownsDatabase&&!(source instanceof Database))throw new TypeError('ProgramStore requires a database path or an existing Bun Database.');
    if(this.ownsDatabase){
      if(source!==':memory:')mkdirSync(dirname(source),{recursive:true});
      this.db=new Database(source,{create:true});
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    }else this.db=source;
    // Borrowed connections retain the owner's pragmas and shutdown lifecycle.
    this.db.exec(`CREATE TABLE IF NOT EXISTS program_transactions(id TEXT PRIMARY KEY,status TEXT NOT NULL,tx_hash TEXT UNIQUE,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS program_status ON program_transactions(status);`);
  }
  get(id){const r=this.db.query('SELECT data FROM program_transactions WHERE id=?').get(id);return r?JSON.parse(r.data):null;}
  save(r){this.db.query(`INSERT INTO program_transactions VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,tx_hash=excluded.tx_hash,data=excluded.data`).run(r.id,r.status,r.txHash??null,JSON.stringify(r));return r;}
  prune(now){this.db.query("DELETE FROM program_transactions WHERE status='prepared' AND tx_hash IS NULL AND json_extract(data,'$.createdAt')<?").run(now-86400000);}
  listForReconcile(status,limit=100){return this.db.query("SELECT data FROM program_transactions WHERE status=? ORDER BY coalesce(json_extract(data,'$.checkedAt'),0) ASC LIMIT ?").all(status,limit).map(r=>JSON.parse(r.data));}
  checked(id,at){this.db.query("UPDATE program_transactions SET data=json_set(data,'$.checkedAt',?) WHERE id=?").run(at,id);}
  list(status){return this.db.query('SELECT data FROM program_transactions WHERE status=? LIMIT 100').all(status).map(r=>JSON.parse(r.data));}
  close(){if(this.ownsDatabase)this.db.close();}
}
