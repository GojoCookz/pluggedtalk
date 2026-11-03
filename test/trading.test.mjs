import { afterEach,describe,expect,test } from 'bun:test';
import { encodeAbiParameters,encodeEventTopics,decodeFunctionData,parseAbiParameters,keccak256,erc20Abi } from '../../app/node_modules/viem/_esm/index.js';
import { LaunchStore } from '../lib/launch-store.mjs';
import { TradingService,tradingAmount,tradingPool } from '../lib/trading-service.mjs';
import { TRADING_ABI,POOL_KEY } from '../lib/trading-abi.mjs';
import { CARBON_DEFAULT as engine } from '../lib/carbon-abi.mjs';
import { tradingFixtures } from './trading-fixtures.mjs';

const account='0x1111111111111111111111111111111111111111',token='0x2222222222222222222222222222222222222222',quote='0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const hash='0x'+'ab'.repeat(32),blockHash='0x'+'cd'.repeat(32),key={currency0:token,currency1:quote,fee:0,tickSpacing:60,hooks:engine.feeHook};
const poolId=keccak256(encodeAbiParameters(parseAbiParameters(POOL_KEY),[key]));
let stores=[];
afterEach(()=>{for(const store of stores)store.close();stores=[];});
function setup(){
  let now=1800000000000;const store=new LaunchStore(':memory:');stores.push(store);
  const launch={id:'fixture-launch',fingerprint:'unique',status:'confirmed',createdAt:now,token,poolId,txHash:hash,input:{quote,symbol:'TEST'},params:{pair:quote,tickSpacing:60}};
  store.save(launch);
  const s={launch,key,blockNumber:100n,blockHash,blockTimestamp:BigInt(now/1000),nativeBalance:10n**18n,
    token:{address:token,symbol:'TEST',decimals:18,balance:10n**24n,allowance:10n**24n},quote:{address:quote,symbol:'USDG',decimals:6,balance:100000000n,allowance:100000000n}};
  const calls=[];
  const client={
    simulateContract:async call=>{calls.push(call);if(call.functionName==='approve')return {result:true};if(call.args[3]>1000n)throw new Error('TooLittleReceived');return {result:1000n};},
    estimateContractGas:async()=>100000n,getGasPrice:async()=>1000n,getBlockNumber:async()=>103n,getBlock:async()=>({hash:blockHash,timestamp:BigInt(now/1000)}),
    getTransaction:async()=>{throw Object.assign(new Error('Not found'),{name:'TransactionNotFoundError'});},
  };
  const launchService={store,client,submit:async()=>launch,deployment:async()=>{}};
  const service=new TradingService({launchService,now:()=>now});
  // Wallet accounting tests inject a coherent pinned snapshot; deployment pin is independently tested below and live.
  service.snapshot=async(t,a)=>{await service.launch(t);return s;};
  const input={token,account,side:'buy',amount:'1',slippageBps:50};
  return {service,client,store,s,input,calls,launchService,tick:ms=>now+=ms};
}
async function submittedFixture(f,{out=999n,recipient=account,eventCount=1,status='success',canonical=true,confirmations=true}={}){
  const q=await f.service.quote(f.input),p=await f.service.prepare({id:q.id,account});
  const data=encodeAbiParameters(parseAbiParameters(`${POOL_KEY},bool,uint256,uint256`),[key,false,1000000n,out]);
  const topics=encodeEventTopics({abi:TRADING_ABI,eventName:'Traded',args:{trader:account,recipient}});
  f.client.getTransaction=async()=>({from:account,to:engine.tradeRouter,input:p.transaction.data,value:0n,chainId:4663,nonce:7,blockNumber:101n,blockHash});
  f.client.getTransactionReceipt=async()=>({status,blockNumber:101n,blockHash:canonical?blockHash:'0x'+'ef'.repeat(32),logs:Array.from({length:eventCount},()=>({address:engine.tradeRouter,data,topics}))});
  f.client.getBlockNumber=async()=>confirmations?103n:102n;
  return p;
}

describe('Plugged trade validation and exact-unit math',()=>{
  test('integration fixtures serialize and encode the documented router protection',()=>{
    const f=JSON.parse(JSON.stringify(tradingFixtures(1800000000000)));
    const call=decodeFunctionData({abi:TRADING_ABI,data:f.prepare.transaction.data});
    expect(call.args.slice(1)).toEqual([false,BigInt(f.quote.amountIn),BigInt(f.quote.minimumOutput),account]);
    expect(f.quote.expiresAt-f.quote.createdAt).toBe(60000);
    expect(f.prepare.id).toBe(f.requests.prepare.id);
    expect(decodeFunctionData({abi:erc20Abi,data:f.resetPrepare.transaction.data}).args[1]).toBe(0n);
    expect(f.cancelled.actualOutput).toBeUndefined();
    expect(f.approvalQuote.expectedOutput).toBeNull();
  });
  test('rejects rounding, exponent, zero, negative and int128 overflow',()=>{
    for(const value of ['1.0000001','1e3','0','-1','NaN','Infinity',' 1','1.','170141183460469231731687303715884105728'])expect(()=>tradingAmount(value,6)).toThrow();
    expect(tradingAmount('0.000001',6)).toBe(1n);expect(tradingAmount('1.12345678',8)).toBe(112345678n);
  });
  test('sorts pool addresses and rejects altered pool parameters',()=>{
    const f=setup();expect(tradingPool(f.s.launch)).toEqual(key);
    expect(()=>tradingPool({...f.s.launch,params:{pair:quote,tickSpacing:120}})).toThrow('Pool identity');
    expect(()=>tradingPool({...f.s.launch,poolId:hash})).toThrow('Pool identity');
  });
  test('rejects outside Carbon listings, unconfirmed and reorged launches',async()=>{
    const f=setup();await expect(f.service.launch(account)).rejects.toThrow('not a confirmed Plugged');
    f.launchService.submit=async()=>({...f.s.launch,status:'submitted'});
    await expect(f.service.launch(token)).rejects.toThrow('confirmation changed');
  });
  test('code mismatch fails closed before wallet reads',async()=>{
    const f=setup();f.client.getCode=async()=> '0x6000';
    await expect(TradingService.prototype.snapshot.call(f.service,token,account)).rejects.toThrow('bytecode changed');
  });
  test('rejects recipient, native amount, invalid side and slippage fields',async()=>{
    const f=setup();
    for(const bad of [{recipient:account},{amountEth:'1'},{slippageBps:501},{slippageBps:0.5},{reviewSeconds:0},{side:'BUY'}])await expect(f.service.quote({...f.input,...bad})).rejects.toThrow();
  });
  test('buy and sell use exact router call directions and decimals',async()=>{
    const f=setup();const buy=await f.service.quote(f.input),sell=await f.service.quote({...f.input,side:'sell',amount:'1.123456789012345678'});
    expect(buy.zeroForOne).toBe(false);expect(buy.amountIn).toBe('1000000');expect(sell.zeroForOne).toBe(true);expect(sell.amountIn).toBe('1123456789012345678');
    expect(buy.expectedOutput).toBe('1000');expect(buy.minimumOutput).toBe('995');expect(buy.transaction).toBeNull();expect(buy.capabilities.onchainDeadline).toBe(false);
    expect(f.calls[0].blockNumber).toBe(100n);
  });
  test('empty input balance returns no fabricated output and no transaction',async()=>{
    const f=setup();f.s.quote.balance=0n;const q=await f.service.quote(f.input);
    expect(q.next).toBe('fund');expect(q.expectedOutput).toBeNull();expect(f.calls.length).toBe(0);
    await expect(f.service.prepare({id:q.id,account})).rejects.toThrow('Fund');
  });
  test('insufficient nonzero allowance resets then exact amount approval',async()=>{
    const f=setup();f.s.quote.allowance=1n;
    const q=await f.service.quote(f.input),p=await f.service.prepare({id:q.id,account});
    expect(q.approvalAmount).toBe('0');expect(q.expectedOutput).toBeNull();expect(decodeFunctionData({abi:erc20Abi,data:p.transaction.data}).args).toEqual([expect.any(String),0n]);
    f.s.quote.allowance=0n;const fresh=await f.service.quote(f.input),exact=await f.service.prepare({id:fresh.id,account});
    expect(decodeFunctionData({abi:erc20Abi,data:exact.transaction.data}).args[1]).toBe(1000000n);
    await expect(f.service.prepare({id:q.id,account})).rejects.toThrow('Allowance changed');
  });
  test('approval false and gas insufficiency block signing',async()=>{
    const f=setup();f.s.quote.allowance=0n;const q=await f.service.quote(f.input);
    f.client.simulateContract=async()=>({result:false});await expect(f.service.prepare({id:q.id,account})).rejects.toThrow('refused approval');
    f.client.simulateContract=async()=>({result:true});f.s.nativeBalance=0n;
    await expect(f.service.prepare({id:q.id,account})).rejects.toThrow('native ETH');
  });
  test('minimum is original review floor, not a second looser quote',async()=>{
    const f=setup();const q=await f.service.quote(f.input);f.client.simulateContract=async c=>{expect(c.args[3]).toBe(995n);throw new Error('TooLittleReceived');};
    await expect(f.service.prepare({id:q.id,account})).rejects.toThrow('TooLittleReceived');expect(f.service.get(q.id).transaction).toBeNull();
  });
  test('wallet change and expiration block preparation',async()=>{
    const f=setup();const q=await f.service.quote(f.input);
    await expect(f.service.prepare({id:q.id,account:token})).rejects.toThrow('Wallet changed');f.tick(60001);
    await expect(f.service.prepare({id:q.id,account})).rejects.toThrow('expired');
  });
  test('zero output and floor-to-zero never yield signable transaction',async()=>{
    const f=setup();f.client.simulateContract=async()=>({result:1n});await expect(f.service.quote(f.input)).rejects.toThrow('too small');
    f.client.simulateContract=async()=>({result:0n});await expect(f.service.quote({...f.input,slippageBps:0})).rejects.toThrow('too small');
  });
});
describe('durable trade confirmation and adversarial receipts',()=>{
  test('calldata carries exact minimum and recipient, no fictitious deadline',async()=>{
    const f=setup(),q=await f.service.quote(f.input),p=await f.service.prepare({id:q.id,account}),call=decodeFunctionData({abi:TRADING_ABI,data:p.transaction.data});
    expect(call.args.length).toBe(5);expect(call.args.slice(1)).toEqual([false,1000000n,995n,account]);expect(p.transaction.value).toBe('0x0');expect(p.transaction.chainId).toBe('0x1237');
  });
  test('exact canonical event confirms actual output, survives service restart',async()=>{
    const f=setup(),p=await submittedFixture(f);const r=await f.service.submit({id:p.id,txHash:hash});
    expect(r.status).toBe('confirmed');expect(r.actualOutput).toBe('999');expect(r.transaction).toBeNull();
    const restarted=new TradingService({launchService:f.launchService});expect((await restarted.status({id:p.id})).status).toBe('confirmed');
    await expect(f.service.prepare({id:p.id,account})).rejects.toThrow('already submitted');
  });
  test('RPC not found preserves recovery without pretending failed or confirmed',async()=>{
    const f=setup(),q=await f.service.quote(f.input);await f.service.prepare({id:q.id,account});
    expect((await f.service.submit({id:q.id,txHash:hash})).status).toBe('not_found');expect(f.service.get(q.id).txHash).toBeUndefined();
  });
  test('receipt absence stays submitted',async()=>{
    const f=setup(),p=await submittedFixture(f);f.client.getTransactionReceipt=async()=>{throw Object.assign(new Error('pending'),{name:'TransactionReceiptNotFoundError'});};
    expect((await f.service.submit({id:p.id,txHash:hash})).status).toBe('submitted');
  });
  test('reorg and fewer than two additional blocks stay submitted',async()=>{
    for(const opts of [{canonical:false},{confirmations:false}]){const f=setup(),p=await submittedFixture(f,opts);expect((await f.service.submit({id:p.id,txHash:hash})).status).toBe('submitted');}
  });
  test('missing, duplicate, wrong recipient, below-minimum events are rejected',async()=>{
    for(const opts of [{eventCount:0},{eventCount:2},{recipient:token},{out:994n}]){const f=setup(),p=await submittedFixture(f,opts);await expect(f.service.submit({id:p.id,txHash:hash})).rejects.toThrow();}
  });
  test('wrong chain, sender, recipient, value and calldata are rejected',async()=>{
    for(const bad of [{chainId:1},{from:token},{to:quote},{value:1n},{input:'0x'}]){
      const f=setup(),p=await submittedFixture(f),original=await f.client.getTransaction();f.client.getTransaction=async()=>({...original,...bad});
      await expect(f.service.submit({id:p.id,txHash:hash})).rejects.toThrow('differs');
    }
  });
  test('reverted receipt is terminal only once canonical and confirmed',async()=>{
    const f=setup(),p=await submittedFixture(f,{status:'reverted'});expect((await f.service.submit({id:p.id,txHash:hash})).status).toBe('reverted');
  });
  test('late mined transaction can be recovered despite application expiry',async()=>{
    const f=setup(),p=await submittedFixture(f);f.tick(180000);expect((await f.service.submit({id:p.id,txHash:hash})).status).toBe('confirmed');
  });
  test('same-nonce speed-up and cancellation reconcile without unlocking early',async()=>{
    for(const cancel of [false,true]){
      const f=setup(),p=await submittedFixture(f),original=await f.client.getTransaction(),receipt=await f.client.getTransactionReceipt(),newHash='0x'+'11'.repeat(32);
      f.client.getTransactionReceipt=async({hash:h})=>{if(h===hash)throw Object.assign(new Error('pending'),{name:'TransactionReceiptNotFoundError'});return receipt;};
      await f.service.submit({id:p.id,txHash:hash});
      f.client.getTransaction=async({hash:h})=>h===newHash?{...original,...(cancel?{to:account,input:'0x'}:{})}:original;
      f.client.getBlockNumber=async()=>102n;
      expect((await f.service.status({id:p.id,txHash:newHash,replaces:hash})).status).toBe('submitted');
      f.client.getBlockNumber=async()=>103n;
      const r=await f.service.status({id:p.id});expect(r.status).toBe(cancel?'cancelled':'confirmed');expect(r.previousHashes).toEqual([hash]);
      expect((await f.service.status({id:p.id,txHash:newHash,replaces:hash})).status).toBe(r.status);
    }
  });
  test('L6: concurrent replacements compare-and-set; the loser cannot overwrite the winner',async()=>{
    const f=setup(),p=await submittedFixture(f),original=await f.client.getTransaction();
    f.client.getTransactionReceipt=async()=>{throw Object.assign(new Error('pending'),{name:'TransactionReceiptNotFoundError'});};
    await f.service.submit({id:p.id,txHash:hash});
    const a='0x'+'21'.repeat(32),b='0x'+'22'.repeat(32);let release;const gate=new Promise(r=>release=r);
    f.client.getTransaction=async({hash:h})=>{if(h===a||h===b)await gate;return original;};
    const first=f.service.status({id:p.id,txHash:a,replaces:hash}),second=f.service.status({id:p.id,txHash:b,replaces:hash});
    release();
    const results=await Promise.allSettled([first,second]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected').reason.code).toBe('TRADING_CONFLICT');
    const stored=f.service.get(p.id);expect([a,b]).toContain(stored.txHash);expect(stored.previousHashes).toEqual([hash]);
  });
  test('L6: a status check that started before a replacement cannot write its stale hash back',async()=>{
    const f=setup(),p=await submittedFixture(f),original=await f.client.getTransaction(),receipt=await f.client.getTransactionReceipt();
    const newHash='0x'+'23'.repeat(32);let release;const gate=new Promise(r=>release=r);
    f.client.getTransactionReceipt=async({hash:h})=>{if(h===hash)throw Object.assign(new Error('pending'),{name:'TransactionReceiptNotFoundError'});return receipt;};
    await f.service.submit({id:p.id,txHash:hash});
    f.client.getTransaction=async({hash:h})=>{if(h===hash)await gate;return original;};
    const stale=f.service.status({id:p.id});
    f.client.getTransaction=async()=>original;
    await f.service.status({id:p.id,txHash:newHash,replaces:hash}).catch(()=>{});
    release();
    await stale.catch(e=>expect(e.code).toBe('TRADING_CONFLICT'));
    expect(f.service.get(p.id).txHash).toBe(newHash);
  });
  test('replacement rejects changed nonce, trade calldata, foreign sender and mined original',async()=>{
    for(const bad of [{nonce:8},{input:'0x1234'},{from:token},{value:1n},{chainId:1}]){
      const f=setup(),p=await submittedFixture(f),original=await f.client.getTransaction();
      f.client.getTransactionReceipt=async()=>{throw Object.assign(new Error('pending'),{name:'TransactionReceiptNotFoundError'});};
      await f.service.submit({id:p.id,txHash:hash});f.client.getTransaction=async()=>({...original,...bad});
      await expect(f.service.status({id:p.id,txHash:'0x'+'12'.repeat(32)})).rejects.toMatchObject({code:'TRADING_REPLACEMENT'});
    }
    const f=setup(),p=await submittedFixture(f);await f.service.submit({id:p.id,txHash:hash});
    await expect(f.service.status({id:p.id,txHash:'0x'+'12'.repeat(32)})).rejects.toMatchObject({code:'TRADING_ORIGINAL_MINED'});
  });
});
