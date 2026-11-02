// Separate table: rewards must never become launch listings. Reuses the parent's
// durable SQLite connection without changing launch schema or ownership settings.
export class RewardsStore {
  constructor(db){
    if(!db)throw new Error('Rewards require the durable launch database.');
    this.db=db;
    db.exec('CREATE TABLE IF NOT EXISTS reward_preparations (id TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL)');
  }
  get(id){const row=this.db.query('SELECT data FROM reward_preparations WHERE id=?').get(id);return row?JSON.parse(row.data):null;}
  save(record){this.db.query('INSERT INTO reward_preparations VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(record.id,record.createdAt,JSON.stringify(record));}
  attach(id,txHash){return this.db.transaction(()=>{const record=this.get(id);if(!record)throw new Error('Preparation not found.');if(record.txHash&&record.txHash.toLowerCase()!==txHash.toLowerCase())throw new Error('A different transaction is already attached.');record.txHash=txHash.toLowerCase();record.status='submitted';this.save(record);return record;})();}
}
