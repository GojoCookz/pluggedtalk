import { expect,test,spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchStore } from '../lib/launch-store.mjs';
import { ProgramStore } from '../lib/program-service-store.mjs';
import { ProgramService } from '../lib/program-service.mjs';

const record={id:'program-test',status:'submitted',txHash:'0x'+'12'.repeat(32)};

test('borrowed launch database keeps owner settings and remains open after program shutdown',()=>{
  const launches=new LaunchStore(':memory:');
  try{
    launches.db.exec('PRAGMA busy_timeout=1234;');
    const programs=new ProgramStore(launches.db);
    const service=new ProgramService({launchService:{store:launches},store:programs,manifest:[]});
    expect(programs.db).toBe(launches.db);expect(programs.ownsDatabase).toBe(false);
    expect(launches.db.query('PRAGMA busy_timeout').get().timeout).toBe(1234);
    programs.save(record);service.close();service.close();
    expect(launches.db.query('SELECT count(*) AS n FROM program_transactions').get().n).toBe(1);
    const reopened=new ProgramStore(launches.db);expect(reopened.get(record.id)).toEqual(record);reopened.close();
    expect(launches.db.query('SELECT count(*) AS n FROM launches').get().n).toBe(0);
  }finally{launches.close();}
});

test('path-owned program database persists records and closes its own connection',()=>{
  const directory=mkdtempSync(join(tmpdir(),'plugged-program-store-')),path=join(directory,'programs.sqlite');
  let store;
  try{
    store=new ProgramStore(path);expect(store.ownsDatabase).toBe(true);store.save(record);store.close();
    expect(()=>store.db.query('SELECT 1').get()).toThrow();
    store=new ProgramStore(path);expect(store.get(record.id)).toEqual(record);store.close();store=null;
  }finally{store?.close();rmSync(directory,{recursive:true,force:true});}
});

test('only real Bun Database objects can be borrowed',()=>{
  expect(()=>new ProgramStore({exec(){},query(){}})).toThrow('existing Bun Database');
  const db=new Database(':memory:');
  try{const store=new ProgramStore(db);store.close();expect(db.query('SELECT 1 AS n').get().n).toBe(1);}finally{db.close();}
});

test('reconciliation logs omit RPC credentials and continue to the next record',async()=>{
  const store=new ProgramStore(':memory:'),service=new ProgramService({store,manifest:[]});
  store.save(record);store.save({...record,id:'second-program-test',txHash:'0x'+'34'.repeat(32)});
  const visited=[];service.confirm=async r=>{visited.push(r.id);throw Object.assign(new Error('https://rpc-user:rpc-password@example.test/?api_key=secret-value'),{shortMessage:'Bearer secret-value'});};
  const logger=spyOn(console,'error').mockImplementation(()=>{});
  try{
    await service.reconcile();expect(visited).toHaveLength(2);expect(logger).toHaveBeenCalledTimes(2);
    const output=JSON.stringify(logger.mock.calls);
    for(const sensitive of ['rpc-user','rpc-password','example.test','api_key','secret-value','Bearer'])expect(output).not.toContain(sensitive);
    expect(store.list('submitted')).toHaveLength(2);
  }finally{logger.mockRestore();service.close();}
});
