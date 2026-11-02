import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {encodeAbiParameters,encodeEventTopics,decodeFunctionData,keccak256,zeroAddress,erc20Abi} from '../../app/node_modules/viem/_esm/index.js';
import {RewardsService} from '../lib/rewards-service.mjs';
import {RewardsStore} from '../lib/rewards-store.mjs';
import {REWARDS_HOOK_ABI as H,REWARDS_DISTRIBUTOR_ABI as D,REWARDS_SPLITTER_ABI as S,rewardsPool} from '../lib/rewards-abi.mjs';
import {CARBON_DEFAULT as engine} from '../lib/carbon-abi.mjs';
import {QUOTES} from '../lib/config.mjs';
import {resolveSocial,resolvedRecipient} from '../lib/social-service.mjs';
const account='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222',token='0x3333333333333333333333333333333333333333',distributor='0x4444444444444444444444444444444444444444',splitter='0x5555555555555555555555555555555555555555';
const quote=QUOTES.find(q=>q.symbol==='USDG').address,hash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64),planHash='0x'+'c'.repeat(64),pool=rewardsPool(token,quote);
function fixture(options={}){
  const db=new Database(':memory:');
  const record={token,status:'confirmed',input:{name:'Local fixture',symbol:'TEST',quote,feeRecipient:account,creatorBps:5000},params:{tickSpacing:60},poolId:pool.poolId,blockNumber:'90',blockHash};
  const state={block:100n,chain:4663,holder:123n,deferred:50n,pending:200n,pendingToken:0n,config:[distributor,quote,200,account,5000,true],sim:123n,code:'0x1234',...options};
  const client={
    getChainId:async()=>state.chain,getBlockNumber:async()=>state.block,getBlock:async()=>({hash:state.canonical??blockHash}),getCode:async()=>state.code,
    readContract:async({address:a,functionName:f,args})=>{
      if(state.fail===f)throw new Error('RPC unavailable');
      const values={poolConfig:state.config,distributor,shareToken:token,payoutToken:quote,controller:engine.feeHook,pendingFees:state.pending,pendingTokenFees:state.pendingToken,balanceOf:2000n,withdrawableOf:state.holder,withdrawnOf:5n,shareOf:100n,decimals:6,currency:state.currency??quote,planHash,recipientCount:1n,recipients:account,sharesBps:10000n,claimable:123n,released:4n};
      if(!(f in values))throw new Error('Unmocked read '+f);return values[f];
    },
    simulateContract:async call=>{state.call=call;if(state.simError)throw new Error('Simulation reverted');return {result:state.sim};},
    estimateContractGas:async()=>100000n,getTransaction:async()=>state.tx,
    getTransactionReceipt:async()=>{if(!state.receipt){const e=new Error('not found');e.name='TransactionReceiptNotFoundError';throw e;}return state.receipt;},
  };
  const launchService={client,store:{db,list:()=>state.records??[record]},deployment:async()=>{if(state.deploymentError)throw new Error('Engine code changed');}};
  const manifest={address:splitter,chainId:4663,codeHash:keccak256('0x1234'),currency:state.currency??quote,planHash,recipients:[{address:account,bps:10000}]};
  const service=new RewardsService({launchService,now:()=>100000,splitters:state.splitters?[manifest]:[]});
  return {db,state,service,launchService,manifest};
}
const req=action=>({account,chainId:4663,action,token});
function attach(state,p,{action=p.action,recipient=account,currency=quote,amount=123n}={}){
  state.tx={from:account,to:p.transaction.to,input:p.transaction.data,value:0n,chainId:4663,blockNumber:100n,blockHash};
  const abi=action==='holder'?D:action==='splitter'?S:H;
  const isSweep=['creator','sweep'].includes(action),eventName={holder:'PayoutSent',creator:'FeeTaken',splitter:'Released',sweep:'FeeTaken'}[action];
  const args=action==='holder'?{account:recipient}:action==='splitter'?{recipient,currency}:{poolId:pool.poolId};
  const data=isSweep?encodeAbiParameters(Array(4).fill({type:'uint256'}),[200n,100n,99n,1n]):encodeAbiParameters([{type:'uint256'}],[amount]);
  state.receipt={transactionHash:hash,from:account,to:p.transaction.to,blockNumber:100n,blockHash,status:'success',logs:[{address:p.transaction.to,topics:encodeEventTopics({abi,eventName,args}),data}]};
  if(isSweep)for(const [to,value] of [[account,99n],[distributor,100n]])state.receipt.logs.push({address:quote,topics:encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from:engine.feeHook,to}}),data:encodeAbiParameters([{type:'uint256'}],[value])});state.block=102n;
}
const submission=p=>({preparation:{id:p.id},account,chainId:4663,txHash:hash});
test('reads real separate units and explicit splitter/social configuration state',async()=>{
  const {service,db}=fixture();const r=await service.positions({account,chainId:4663});expect(r.positions[0].pendingQuote).toBe('200');expect(r.positions[0].holderClaimable).toBe('123');expect(r.positions[0].deferredRecovery).toBe('unsupported-by-deployed-hook');expect(r.positions[0].creatorClaimable).toBe(null);expect(r.splitters.status).toBe('unconfigured');expect(r.social.oauthAvailable).toBe(false);db.close();
});
test('only confirmed Plugged launches are discovered; RPC failures are not zero balances',async()=>{
  const {service,state,db}=fixture({records:[]});expect((await service.positions({account,chainId:4663})).positions).toEqual([]);await expect(service.prepare(req('holder'))).rejects.toThrow('confirmed Plugged');db.close();
  const f=fixture({fail:'withdrawableOf'});const r=await f.service.positions({account,chainId:4663});expect(r.positions[0].status).toBe('unavailable');expect(r.positions[0].holderClaimable).toBeUndefined();f.db.close();
});
for(const action of ['holder','creator','sweep'])test(`${action} binds simulation and calldata, verifies canonical receipt and survives service restart`,async()=>{
  const {service,state,db,launchService}=fixture();const p=await service.prepare(req(action));expect(state.call.account).toBe(account);expect(p.transaction.value).toBe('0x0');expect(p.transaction.chainId).toBe('0x1237');expect(decodeFunctionData({abi:action==='holder'?D:H,data:p.transaction.data}).functionName).toBe({holder:'withdraw',creator:'sweep',sweep:'sweep'}[action]);
  attach(state,p);const restarted=new RewardsService({launchService});const result=await restarted.submit(submission(p));expect(result.status).toBe('confirmed');expect(result.verified).toBe(true);expect((await restarted.submit(submission(p))).receipt.event).toBe(result.receipt.event);db.close();
});
test('rejects arbitrary targets, redirects, calldata and amount overrides before simulation',async()=>{
  const {service,state,db}=fixture();for(const field of ['to','recipient','splitter','amount','amountRaw','data','redirect','callbackUrl'])await expect(service.prepare({...req('holder'),[field]:field==='amount'?'-1':other})).rejects.toThrow();
  for(const n of ['0','-1','NaN','1e999','1.2',2**53,{},null])await expect(service.prepare({...req('holder'),amount:n})).rejects.toThrow();expect(state.call).toBeUndefined();db.close();
});
test('wrong account/chain, zero balances, mismatched distributor and reorg launch fail closed',async()=>{
  const {service,state,db}=fixture();await expect(service.prepare({...req('holder'),account:zeroAddress})).rejects.toThrow();await expect(service.prepare({...req('holder'),chainId:1})).rejects.toThrow();state.chain=1;await expect(service.prepare(req('holder'))).rejects.toThrow('RPC');state.chain=4663;
  state.holder=0n;await expect(service.prepare(req('holder'))).rejects.toThrow('Nothing');state.holder=123n;state.config[0]=other;await expect(service.prepare(req('holder'))).rejects.toThrow('configuration');state.config[0]=distributor;state.canonical=hash;await expect(service.prepare(req('holder'))).rejects.toThrow('confirmation changed');db.close();
});
test('failed or zero simulation never issues a preparation',async()=>{
  const {service,state,db}=fixture({sim:0n});await expect(service.prepare(req('holder'))).rejects.toThrow('no payout');state.simError=true;await expect(service.prepare(req('holder'))).rejects.toThrow('reverted');expect(db.query('SELECT COUNT(*) n FROM reward_preparations').get().n).toBe(0);db.close();
});
test('submit ignores forged browser preparation, rejects stale wallet and transaction mutations',async()=>{
  const {service,state,db}=fixture();const p=await service.prepare(req('holder'));attach(state,p);
  await expect(service.submit({...submission(p),account:other})).rejects.toThrow('wallet');
  for(const [key,value] of [['from',other],['to',other],['chainId',1],['value',1n],['input','0x1234'],['blockNumber',99n]]){const original=state.tx[key];state.tx[key]=value;await expect(service.submit(submission(p))).rejects.toThrow();state.tx[key]=original;}
  expect((await service.submit({...submission(p),preparation:{id:p.id,transaction:{to:other},expected:{recipient:other}}})).verified).toBe(true);db.close();
});
test('pending, confirming, reorg and reverted receipts never claim payment',async()=>{
  const {service,state,db}=fixture();const p=await service.prepare(req('holder'));attach(state,p);const receipt=state.receipt;state.receipt=null;expect((await service.submit(submission(p))).status).toBe('pending');state.receipt=receipt;state.block=101n;expect((await service.submit(submission(p))).status).toBe('confirming');state.block=102n;state.canonical=hash;expect((await service.submit(submission(p))).status).toBe('reorg');state.canonical=blockHash;state.receipt.status='reverted';expect((await service.submit(submission(p))).verified).toBe(false);db.close();
});
test('receipt must contain matching emitter, wallet, currency, positive amount and canonical tx binding',async()=>{
  for(const mutate of [s=>s.receipt.logs[0].address=other,s=>s.receipt.logs=[],s=>s.receipt.transactionHash=blockHash,s=>s.receipt.from=other,s=>s.receipt.to=other,s=>s.receipt.blockHash=hash]){
    const {service,state,db}=fixture();const p=await service.prepare(req('holder'));attach(state,p);mutate(state);await expect(service.submit(submission(p))).rejects.toThrow();db.close();
  }
  for(const changed of [{recipient:other},{currency:other},{amount:0n}]){const {service,state,db}=fixture({splitters:true});const p=await service.prepare({account,chainId:4663,action:'splitter',splitter,recipient:account});attach(state,p,changed);await expect(service.submit(submission(p))).rejects.toThrow();db.close();}
});
test('verified fixed splitter permits another gas payer but never redirects funds',async()=>{
  const {service,state,db}=fixture({splitters:true});const p=await service.prepare({account:other,chainId:4663,action:'splitter',splitter,recipient:account});expect(p.transaction.from).toBe(other);expect(p.expected.recipient).toBe(account);expect(decodeFunctionData({abi:S,data:p.transaction.data}).args).toEqual([account]);
  await expect(service.prepare({account,chainId:4663,action:'splitter',splitter,recipient:other})).rejects.toThrow('fixed beneficiary');state.code='0xabcd';await expect(service.prepare({account,chainId:4663,action:'splitter',splitter,recipient:account})).rejects.toThrow('verification');db.close();
});
test('creator sweep requires configured creator; permissionless sweep never redirects it',async()=>{
  const {service,state,db}=fixture();await expect(service.prepare({...req('creator'),account:other})).rejects.toThrow('Nothing');const p=await service.prepare({...req('sweep'),account:other});expect(p.expected.creator).toBe(account);expect(state.call.account).toBe(other);db.close();
});
test('verified native ETH splitter uses 18 decimals and a zero-value release, never ERC20 approvals',async()=>{
  const {service,state,db}=fixture({splitters:true,currency:zeroAddress});const p=await service.prepare({account,chainId:4663,action:'splitter',splitter,recipient:account});expect(p.expected.decimals).toBe(18);expect(p.expected.symbol).toBe('ETH');expect(p.transaction.value).toBe('0x0');attach(state,p,{currency:zeroAddress});expect((await service.submit(submission(p))).verified).toBe(true);db.close();
});
test('sweep allocations require both creator delivery and holder funding token transfers',async()=>{
  for(const missing of [1,2]){const {service,state,db}=fixture();const p=await service.prepare(req('creator'));attach(state,p);state.receipt.logs.splice(missing,1);const result=await service.submit(submission(p));expect(result.status).toBe('payment-unverified');expect(result.verified).toBe(false);db.close();}
});
test('concurrent sweep becoming a no-op is terminal but never a claimed payment',async()=>{
  const {service,state,db}=fixture();const p=await service.prepare(req('sweep'));attach(state,p);state.receipt.logs=[];const result=await service.submit(submission(p));expect(result.status).toBe('no-op');expect(result.verified).toBe(false);db.close();
});
test('durable transaction hash attachment cannot be replaced after concurrent reads',()=>{
  const {db}=fixture(),store=new RewardsStore(db);store.save({id:'race',createdAt:1});expect(store.get('race').txHash).toBeUndefined();store.attach('race',hash);expect(()=>store.attach('race',blockHash)).toThrow('different transaction');expect(store.get('race').txHash).toBe(hash);db.close();
});
test('unconfigured and malformed splitter deployments cannot prepare claims',async()=>{
  const f=fixture();await expect(f.service.prepare({account,chainId:4663,action:'splitter',splitter,recipient:account})).rejects.toThrow('unconfigured');
  for(const s of [{...f.manifest,chainId:1},{...f.manifest,codeHash:'0x'},{...f.manifest,recipients:[{address:account,bps:9000}]},{...f.manifest,recipients:[{address:account,bps:5000},{address:account,bps:5000}]}])expect(()=>new RewardsService({launchService:f.launchService,splitters:[s]})).toThrow();f.db.close();
});
test('social resolver rejects redirect targets, missing key and spoofed profile URLs',async()=>{
  for(const extra of [{redirect:'https://evil.test'},{wallet:other},{claimTarget:other},{callbackUrl:'javascript:alert(1)'}])await expect(resolveSocial({kind:'github',username:'octocat',...extra},{apiKey:'test'})).rejects.toThrow('only');
  await expect(resolveSocial({kind:'github',username:'octocat'},{apiKey:''})).rejects.toThrow('BAGS_API_KEY');
  for(const username of ['https://github.com@evil.test/foo','https://github.com/foo/repo','https://github.com/foo?redirect=https://evil.test'])await expect(resolveSocial({kind:'github',username},{apiKey:'test'})).rejects.toThrow();
});
test('social success means resolved address, not OAuth or authenticated wallet control',async()=>{
  let request;const options={apiKey:'fixture',secret:'fixture-secret',now:()=>1000,fetcher:async(url,init)=>{request=init;return {ok:true,json:async()=>({success:true,response:{chain:'EVM',provider:'github',wallet:account,platformData:{id:'fixture-id',username:'octocat'}}})};}};
  const r=await resolveSocial({kind:'github',username:'octocat'},options);expect(r.walletControl).toBe('unverified');expect(r.oauthAvailable).toBe(false);expect(request.redirect).toBe('error');
  const row={kind:'github',username:'octocat',resolution:r};expect(resolvedRecipient(row,options)).toBe(account);expect(()=>resolvedRecipient({...row,resolution:{...r,wallet:other}},options)).toThrow();expect(()=>resolvedRecipient(row,{...options,now:()=>90000000})).toThrow();
});
