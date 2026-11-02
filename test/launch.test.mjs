import { test,expect } from 'bun:test';
import { encodeFunctionData,encodeEventTopics,encodeAbiParameters,parseUnits } from '../../app/node_modules/viem/_esm/index.js';
import { LAUNCHER_ABI } from '../../app/src/lib/abi.ts';
import { CARBON_ABI,CARBON_DEFAULT } from '../lib/carbon-abi.mjs';
import { LaunchService,launchInput,economicFingerprint,buildCarbonParams } from '../lib/launch-service.mjs';
import { LaunchStore } from '../lib/launch-store.mjs';
import { valuation } from '../lib/usd.mjs';
import { QUOTES } from '../lib/config.mjs';
import { mkdirSync,rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const account='0x1111111111111111111111111111111111111111',token='0x2222222222222222222222222222222222222222',poolId='0x'+'ab'.repeat(32),hash='0x'+'cd'.repeat(32),blockHash='0x'+'ef'.repeat(32);
export const fixture={account,name:'Local fork fixture',symbol:'FORK',quote:'0x5fc5360d0400a0fd4f2af552add042d716f1d168',imageCid:'bafkreicmvyrqyx76pqosx5fdwk6asqdzcaxis6bynbsithhhyav2ggextm',openingBuy:'1',feeBps:200,creatorBps:7500};
function setup(options={}) {
  const store=new LaunchStore(':memory:');
  const client={getBlockNumber:async()=>103n,getChainId:async()=>4663,
    readContract:async({functionName})=>({isApproved:true,pairConfig:{tokenDecimals:6},decimals:6,minDevBuyFor:1n,balanceOf:10000000n,allowance:10000000n,predictTokenAddress:token,...options.reads})[functionName],
    simulateContract:async({functionName})=>({result:functionName==='approve'?true:[token,poolId]}),estimateContractGas:async()=>100000n,
    getBlock:async()=>({hash:blockHash,timestamp:12345n}),...options.client};
  const service=new LaunchService({store,client,fetcher:async()=>new Response('[]'),now:()=>1000000,price:async(q,m)=>({...valuation(QUOTES.find(x=>x.address===q),'1',m),expiresAt:new Date(1060000).toISOString()})});
  service.deployment=async()=>({platformVolumeBps:100,maxFeeBps:1000});return {store,client,service};
}
function receipt(record){return {status:'success',blockNumber:101n,blockHash,logs:[{address:CARBON_DEFAULT.launcher,topics:encodeEventTopics({abi:CARBON_ABI,eventName:'Launched',args:{token,creator:account,pair:fixture.quote}}),data:encodeAbiParameters([{type:'bytes32'},{type:'uint256'},{type:'uint256'},{type:'uint16'}],[poolId,BigInt(record.params.supply),BigInt(record.params.openingMarketCap),200])}]};}
function transaction(record){return {from:account,to:CARBON_DEFAULT.launcher,input:record.transaction.data,value:0n,chainId:4663,blockNumber:104n};}
test('Carbon adapter uses exactly the existing app tuple encoding',()=>{
  const input=launchInput(fixture),price=valuation(QUOTES.find(q=>q.address===input.quote),'1');const params=buildCarbonParams(input,price,'0x'+'12'.repeat(32));
  expect(encodeFunctionData({abi:CARBON_ABI,functionName:'launch',args:[params]})).toBe(encodeFunctionData({abi:LAUNCHER_ABI,functionName:'launch',args:[params]}));
});
test('MVP rejects unsupported programs, native quote, invalid CID and excess token precision',()=>{
  for(const bad of [{programs:{}},{quote:'0x'+'0'.repeat(40)},{imageCid:fixture.imageCid+'a'},{openingBuy:'0.0000001'},{creatorBps:10001}])expect(()=>launchInput({...fixture,...bad})).toThrow();
});
test('identity ignores recipients and images but distinguishes economic changes',()=>{
  const a=launchInput(fixture);expect(economicFingerprint(a)).toBe(economicFingerprint({...a,name:' LOCAL   fork FIXTURE ',feeRecipient:token}));
  expect(economicFingerprint(a)).not.toBe(economicFingerprint({...a,feeBps:300}));
});
test('launch requires approved address, matching registry decimals and live fee floor',async()=>{
  for(const reads of [{isApproved:false},{decimals:18},{pairConfig:{tokenDecimals:18}}]){const {service}=setup({reads});await expect(service.prepare(fixture)).rejects.toThrow();}
  const {service}=setup();await expect(service.prepare({...fixture,feeBps:100})).rejects.toThrow('above 1%');
});
test('unfunded wallets never receive launch calldata; reset nonzero allowance first',async()=>{
  const {service}=setup({reads:{balanceOf:0n}});const r=await service.prepare(fixture);expect(r.next).toBe('fund');expect(r.transaction).toBeNull();expect(r.simulation).toBeNull();
  const a=setup({reads:{allowance:1n}});const p=await a.service.prepare(fixture);expect(p.next).toBe('approve');expect(p.approval.data).toBe(encodeFunctionData({abi:LAUNCHER_ABI.filter(()=>false).concat([{type:'function',name:'approve',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'uint256'}],outputs:[{type:'bool'}]}]),functionName:'approve',args:[CARBON_DEFAULT.launcher,0n]}));
});
test('creator purchase above bounded opening policy and expired prices fail closed',async()=>{
  const {service}=setup();await expect(service.prepare({...fixture,openingBuy:'51'})).rejects.toThrow('creator cap');
  service.now=()=>1060001;await expect(service.prepare(fixture)).rejects.toThrow('Fresh USD');
});
test('failed engine simulation never persists a signable preparation',async()=>{
  const {service,store}=setup({client:{simulateContract:async()=>{throw new Error('execution reverted');}}});await expect(service.prepare(fixture)).rejects.toThrow('reverted');expect(store.list('prepared')).toEqual([]);
});
test('receipt-backed listing validates sender, exact calldata, event and canonical block',async()=>{
  const {service,client,store}=setup();const r=await service.prepare(fixture);client.getTransaction=async()=>({...transaction(r),from:token});await expect(service.submit(r.id,hash)).rejects.toThrow('does not match');
  client.getTransaction=async()=>transaction(r);client.getTransactionReceipt=async()=>({...receipt(r),blockNumber:104n});client.getBlockNumber=async()=>106n;
  expect((await service.submit(r.id,hash)).status).toBe('confirmed');expect((await service.markets()).tokens[0].address).toBe(token);
  await expect(service.prepare(fixture)).rejects.toThrow('identical');
  client.getBlock=async()=>({hash:'0x'+'00'.repeat(32),timestamp:12345n});expect((await service.markets()).tokens).toEqual([]);expect(store.get(r.id).status).toBe('submitted');
});
test('reverts and missing confirmations never enter discovery',async()=>{
  const {service,client}=setup();const r=await service.prepare(fixture);client.getTransaction=async()=>transaction(r);client.getTransactionReceipt=async()=>({...receipt(r),status:'reverted'});
  expect((await service.submit(r.id,hash)).status).toBe('reverted');expect((await service.markets()).tokens).toEqual([]);
});
test('wrong pool event cannot turn a real transaction into a forged listing',async()=>{
  const {service,client}=setup();const r=await service.prepare(fixture);client.getTransaction=async()=>transaction(r);const rec={...r,params:{...r.params,supply:parseUnits('1',18).toString()}};
  client.getTransactionReceipt=async()=>({...receipt(rec),blockNumber:104n});client.getBlockNumber=async()=>106n;
  await expect(service.submit(r.id,hash)).rejects.toThrow('differs');expect((await service.markets()).tokens).toEqual([]);
});
test('prepared and submitted records survive a real SQLite reopen',()=>{
  const path=fileURLToPath(new URL(`../artifacts/store-${crypto.randomUUID()}.sqlite`,import.meta.url));
  mkdirSync(fileURLToPath(new URL('../artifacts/',import.meta.url)),{recursive:true});
  try{let store=new LaunchStore(path);store.save({id:'durable',fingerprint:'identity',status:'submitted',createdAt:1,txHash:hash,input:{name:'Persistent fixture'}});store.close();store=new LaunchStore(path);expect(store.get('durable').txHash).toBe(hash);expect(store.list('submitted')).toHaveLength(1);store.close();}
  finally{for(const suffix of ['', '-wal','-shm'])rmSync(path+suffix,{force:true});}
});
test('preparation does not call getters absent from the pinned live engine',async()=>{
  const {service,client}=setup();const read=client.readContract;client.readContract=async args=>{expect(args.functionName).not.toBe('minDevBuyFor');return read(args);};
  expect((await service.prepare(fixture)).next).toBe('launch');
});
