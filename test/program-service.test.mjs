import { afterEach, describe, expect, test } from 'bun:test';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, parseEther, zeroAddress } from '../../app/node_modules/viem/_esm/index.js';
import { ProgramService, programManifest } from '../lib/program-service.mjs';
import { ProgramStore } from '../lib/program-service-store.mjs';
import { CAMPAIGN_ABI } from '../lib/program-service-abi.mjs';

const account='0x1111111111111111111111111111111111111111';
const beneficiary='0x2222222222222222222222222222222222222222';
const address='0x3333333333333333333333333333333333333333';
const h=byte=>`0x${byte.repeat(64)}`;
const code='0x60006000';
const timestamp=1800000000n;
const manifest=(overrides={})=>({id:'campaign',kind:'campaign',chainId:31337,localTest:true,address,codeHash:keccak256(code),deploymentBlock:'1',deploymentBlockHash:h('1'),currency:zeroAddress,decimals:18,beneficiary,goal:parseEther('2').toString(),deadline:(timestamp+3600n).toString(),...overrides});
const services=[];
afterEach(()=>{for(const service of services.splice(0))service.close();});

function fixture({entry=manifest(),enabled=true}={}) {
  const state={chainId:31337,code,originHash:h('1'),preparedHash:h('a'),receiptHash:h('b'),latest:103n,
    values:{CURRENCY:entry.currency,BENEFICIARY:entry.beneficiary,GOAL:BigInt(entry.goal),DEADLINE:BigInt(entry.deadline),totalContributed:0n,totalRefunded:0n,paid:false,contributions:0n},calls:[]};
  const client={
    getChainId:async()=>state.chainId,
    getCode:async()=>state.code,
    getBlock:async({blockNumber=100n}={})=>({number:blockNumber,timestamp,hash:blockNumber===1n?state.originHash:blockNumber===100n?state.preparedHash:state.receiptHash}),
    getBlockNumber:async()=>state.latest,
    readContract:async({functionName})=>state.values[functionName],
    simulateContract:async args=>{state.calls.push(args);return {request:args};},
    estimateGas:async()=>50000n,
    getTransaction:async()=>state.tx,
    getTransactionReceipt:async()=>{if(state.receiptError)throw state.receiptError;return state.receipt;},
  };
  const service=new ProgramService({client,manifest:[entry],store:new ProgramStore(':memory:'),enabled,now:()=>Number(timestamp)*1000});
  services.push(service);
  return {service,state,client};
}

function contributionLog(amount=parseEther('1'),contributor=account) {
  return {address,topics:encodeEventTopics({abi:CAMPAIGN_ABI,eventName:'Contributed',args:{contributor}}),data:encodeAbiParameters([{type:'uint256'}],[amount])};
}
async function preparedFixture() {
  const f=fixture();
  const record=await f.service.prepare({programId:'campaign',account,action:'contribute',amount:'1'});
  f.state.tx={hash:h('c'),from:account,to:address,input:record.transaction.data,value:parseEther('1'),chainId:31337,blockNumber:101n};
  f.state.receipt={transactionHash:h('c'),from:account,to:address,status:'success',blockNumber:101n,blockHash:h('b'),logs:[contributionLog()]};
  return {...f,record};
}

describe('verified program gating and preparation',()=>{
  test('manifest prevents ambiguous identity and local/production chain confusion',()=>{
    expect(programManifest([manifest()])[0]).toMatchObject({localTest:true,symbol:'ETH'});
    for(const change of [{chainId:4663},{localTest:false},{chainId:1},{decimals:6},{address:zeroAddress},{beneficiary:address},{goal:'0'},{codeHash:'0x1234'}]) {
      expect(()=>programManifest([manifest(change)])).toThrow();
    }
    expect(()=>programManifest([manifest(),manifest({id:'other'})])).toThrow('Duplicate');
    expect(()=>programManifest([manifest(),manifest({address:account})])).toThrow('Duplicate');
  });

  test('disabled and undeployed gates never produce a wallet transaction',async()=>{
    const disabled=fixture({enabled:false});
    await expect(disabled.service.prepare({programId:'campaign',account,action:'contribute',amount:'1'})).rejects.toThrow('disabled');
    expect(disabled.state.calls).toHaveLength(0);
    const f=fixture();f.state.code='0x';
    const list=await f.service.list();
    expect(list.status).toBe('undeployed');expect(list.programs).toHaveLength(0);
    expect(list.unavailable[0].reason).toContain('bytecode is absent');
    await expect(f.service.prepare({programId:'campaign',account,action:'contribute',amount:'1'})).rejects.toThrow('bytecode is absent');
    expect(f.state.calls).toHaveLength(0);
  });

  test('chain, deployment reorg, code, immutable and future-deployment mismatches fail closed',async()=>{
    for(const mutate of [s=>s.chainId=4663,s=>s.originHash=h('f'),s=>s.code='0x6001',s=>s.values.BENEFICIARY=account]) {
      const f=fixture();mutate(f.state);
      await expect(f.service.details('campaign')).rejects.toThrow();
    }
    await expect(fixture({entry:manifest({deploymentBlock:'101'})}).service.details('campaign')).rejects.toThrow('not deployed');
  });

  test('native preparation binds wallet, value, calldata, chain and a finite expiry',async()=>{
    const {service,state}=fixture();
    const r=await service.prepare({programId:'campaign',account,action:'contribute',amount:'1.25'});
    expect(r.transaction).toMatchObject({from:account,to:address,chainId:'0x7a69',value:'0x1158e460913d0000',gas:'0xea60'});
    expect(decodeFunctionData({abi:CAMPAIGN_ABI,data:r.transaction.data})).toEqual({functionName:'contribute',args:[parseEther('1.25')]});
    expect(r.expiresAt-r.createdAt).toBe(120000);
    expect(state.calls[0]).toMatchObject({account,address,value:parseEther('1.25')});
    expect(service.store.get(r.id)).toEqual(r);
  });

  test('invalid amounts, action fields and beneficiary redirection never simulate',async()=>{
    const {service,state}=fixture();
    const body={programId:'campaign',account,action:'contribute',amount:'1'};
    for(const amount of ['0','-1','1e3','0.0000000000000000001',1,' 1']) {
      await expect(service.prepare({...body,amount})).rejects.toThrow();
    }
    await expect(service.prepare({...body,beneficiary:account})).rejects.toThrow('Unsupported request fields');
    await expect(service.prepare({...body,action:'claim'})).rejects.toThrow('Action is not valid');
    await expect(service.prepare({...body,voucher:{}})).rejects.toThrow('Unexpected action parameters');
    expect(state.calls).toHaveLength(0);
  });
});

describe('transaction and receipt binding',()=>{
  test('exact receipt confirms only after two additional blocks; missing receipts remain submitted',async()=>{
    const {service,state,record}=await preparedFixture();
    state.receiptError=Object.assign(new Error('pending'),{name:'TransactionReceiptNotFoundError'});
    expect((await service.submit(record.id,h('c'))).status).toBe('submitted');
    delete state.receiptError;state.latest=102n;
    expect((await service.status(record.id)).status).toBe('submitted');
    state.latest=103n;
    expect((await service.status(record.id)).status).toBe('confirmed');
    expect(service.store.get(record.id)).toMatchObject({txHash:h('c'),blockNumber:'101',blockHash:h('b')});
  });

  for(const [field,value] of [['from',beneficiary],['to',beneficiary],['input','0x'],['value',0n],['chainId',4663],['blockNumber',100n]]) {
    test(`rejects transaction ${field} mismatch before attaching its hash`,async()=>{
      const {service,state,record}=await preparedFixture();state.tx[field]=value;
      await expect(service.submit(record.id,h('c'))).rejects.toThrow();
      expect(service.store.get(record.id).txHash).toBeUndefined();
    });
  }

  for(const [field,value] of [['transactionHash',h('d')],['from',beneficiary],['to',beneficiary],['blockNumber',100n]]) {
    test(`rejects receipt ${field} mismatch without confirming`,async()=>{
      const {service,state,record}=await preparedFixture();state.receipt[field]=value;
      if(field==='blockNumber')state.receipt.blockHash=h('a');
      await expect(service.submit(record.id,h('c'))).rejects.toThrow('Receipt does not match');
      expect(service.store.get(record.id).status).toBe('submitted');
    });
  }

  for(const [label,logs] of [
    ['missing',[]],['duplicate',[contributionLog(),contributionLog()]],
    ['wrong emitter',[{...contributionLog(),address:beneficiary}]],
    ['wrong amount',[contributionLog(1n)]],['wrong contributor',[contributionLog(parseEther('1'),beneficiary)]],
    ['malformed',[{address,data:'0x',topics:contributionLog().topics}]],
  ]) {
    test(`rejects ${label} payment events`,async()=>{
      const {service,state,record}=await preparedFixture();state.receipt.logs=logs;
      await expect(service.submit(record.id,h('c'))).rejects.toThrow('Receipt event does not match');
      expect(service.store.get(record.id).status).toBe('submitted');
    });
  }

  test('preparation and receipt reorgs cannot confirm payment',async()=>{
    const f=await preparedFixture();f.state.preparedHash=h('e');
    await expect(f.service.submit(f.record.id,h('c'))).rejects.toThrow('Preparation block was reorganized');
    const g=await preparedFixture();g.state.receiptHash=h('e');
    expect((await g.service.submit(g.record.id,h('c'))).status).toBe('submitted');
  });

  test('reverted receipt is terminal and an attached transaction cannot be replaced',async()=>{
    const {service,state,record}=await preparedFixture();state.receipt.status='reverted';
    expect((await service.submit(record.id,h('c'))).status).toBe('reverted');
    await expect(service.submit(record.id,h('d'))).rejects.toThrow('different transaction');
  });
});
