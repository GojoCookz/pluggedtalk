import { randomUUID } from 'node:crypto';
import { isAddress, zeroAddress, erc20Abi, encodeFunctionData, decodeEventLog, keccak256, toHex } from '../../app/node_modules/viem/_esm/index.js';
import { CARBON_DEFAULT as engine } from './carbon-abi.mjs';
import { QUOTES } from './config.mjs';
import { RewardsStore } from './rewards-store.mjs';
import { REWARDS_HOOK_ABI as H, REWARDS_TOKEN_ABI as T, REWARDS_DISTRIBUTOR_ABI as D, REWARDS_SPLITTER_ABI as S, rewardsPool } from './rewards-abi.mjs';

const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const safe=x=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v));
const address=(a,label='Wallet')=>{if(!isAddress(a??'',{strict:false})||same(a,zeroAddress))throw new Error(`${label}: enter a nonzero EVM address.`);return a.toLowerCase();};
function fields(raw,allowed){if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Provide a JSON object.');for(const k of Object.keys(raw))if(!allowed.includes(k))throw new Error(`Unsupported rewards input: ${k}.`);}
function binding(raw){if(raw.chainId!==4663)throw new Error('Select Robinhood chain 4663.');return address(raw.account);}
function logs(receipt,target,abi){return receipt.logs.filter(l=>same(l.address,target)).flatMap(l=>{try{return [decodeEventLog({abi,data:l.data,topics:l.topics,strict:true})];}catch{return [];}});}

export class RewardsService {
  constructor({launchService,store,splitters=[],now=Date.now}={}){
    if(!launchService?.client||!launchService?.store)throw new Error('Rewards require launchService.');
    this.launchService=launchService;this.client=launchService.client;this.store=store??new RewardsStore(launchService.store.db);this.now=now;
    // Server-owned, independently verified manifests only. Never accept deployments over HTTP.
    this.splitters=structuredClone(splitters);
    for(const s of this.splitters){
      address(s.address,'Splitter');if(s.chainId!==4663||!/^0x[0-9a-f]{64}$/i.test(s.codeHash??'')||!/^0x[0-9a-f]{64}$/i.test(s.planHash??'')||!isAddress(s.currency??'',{strict:false}))throw new Error('Invalid verified splitter manifest.');
      if(!Array.isArray(s.recipients)||!s.recipients.length||s.recipients.length>100)throw new Error('Invalid splitter recipients.');
      const seen=new Set();let sum=0;
      for(const r of s.recipients){const a=address(r.address);if(same(a,s.address)||seen.has(a)||!Number.isInteger(r.bps)||r.bps<1||r.bps>10000)throw new Error('Invalid splitter shares.');seen.add(a);sum+=r.bps;}
      if(sum!==10000)throw new Error('Splitter shares must total 10000.');
    }
  }
  read(target,abi,functionName,args,blockNumber){return this.client.readContract({address:target,abi,functionName,args,blockNumber});}
  confirmed(token){const s=this.launchService.store;return s.confirmedByToken?s.confirmedByToken(token):s.list('confirmed',10000).find(r=>same(r.token,token));}
  async chain(){if(await this.client.getChainId()!==4663)throw new Error('Rewards RPC must be Robinhood chain 4663.');}
  async launch(token,blockNumber){
    const record=this.confirmed(token);
    if(!record)throw new Error('Only confirmed Plugged launches are supported.');
    const block=await this.client.getBlock({blockNumber:BigInt(record.blockNumber)});
    if(!same(block.hash,record.blockHash))throw new Error('Launch confirmation changed. Refresh after reconciliation.');
    const {key,poolId}=rewardsPool(token,record.input.quote,record.params.tickSpacing);
    if(!same(poolId,record.poolId))throw new Error('Launch pool key mismatch.');
    const [config,distributor]=await Promise.all([this.read(engine.feeHook,H,'poolConfig',[poolId],blockNumber),this.read(token,T,'distributor',[],blockNumber)]);
    if(!config[5]||!same(config[0],distributor)||!same(config[1],record.input.quote)||!same(config[3],record.input.feeRecipient)||config[4]!==record.input.creatorBps)throw new Error('Carbon reward configuration differs from the confirmed launch.');
    address(distributor,'Distributor');
    const [share,payout,controller,code]=await Promise.all([this.read(distributor,D,'shareToken',[],blockNumber),this.read(distributor,D,'payoutToken',[],blockNumber),this.read(distributor,D,'controller',[],blockNumber),this.client.getCode({address:distributor,blockNumber})]);
    if(!code||code==='0x'||!same(share,token)||!same(payout,record.input.quote)||!same(controller,engine.feeHook))throw new Error('Distributor binding is invalid.');
    return {record,key,poolId,config,distributor:distributor.toLowerCase(),quote:record.input.quote};
  }
  async carbonPosition(token,account,blockNumber){
    const p=await this.launch(token,blockNumber),q=QUOTES.find(q=>same(q.address,p.quote));
    const [pendingQuote,pendingToken,holderClaimable,holderReceived,shares,decimals,creatorWalletBalance]=await Promise.all([
      this.read(engine.feeHook,H,'pendingFees',[p.poolId],blockNumber),this.read(engine.feeHook,H,'pendingTokenFees',[p.poolId],blockNumber),
      this.read(p.distributor,D,'withdrawableOf',[account],blockNumber),
      this.read(p.distributor,D,'withdrawnOf',[account],blockNumber),this.read(p.distributor,D,'shareOf',[account],blockNumber),this.read(p.quote,erc20Abi,'decimals',[],blockNumber),this.read(p.quote,erc20Abi,'balanceOf',[p.config[3]],blockNumber),
    ]);
    if(!Number.isInteger(decimals)||decimals<0||decimals>255||q&&q.decimals!==decimals)throw new Error('Reward currency decimals changed.');
    return {kind:'carbon',token,name:p.record.input.name,symbol:p.record.input.symbol,poolId:p.poolId,distributor:p.distributor,
      quote:p.quote,quoteSymbol:q?.symbol??p.quote,decimals,creator:p.config[3],creatorBps:p.config[4],isCreator:same(p.config[3],account),
      pendingQuote,pendingToken,creatorWalletBalance,creatorClaimable:null,creatorClaimMode:'sweep',deferredRecovery:'unsupported-by-deployed-hook',holderClaimable,holderReceived,shares,
      holderAmountUnit:'quote-accounting-units',
      actions:{sweep:pendingQuote>0n||pendingToken>0n,holder:holderClaimable>0n,creator:same(p.config[3],account)&&p.config[4]>0&&(pendingQuote>0n||pendingToken>0n)}};
  }
  async splitterPosition(manifest,blockNumber){
    const {address:target,currency,recipients}=manifest;
    const [code,onCurrency,planHash,count]=await Promise.all([this.client.getCode({address:target,blockNumber}),this.read(target,S,'currency',[],blockNumber),this.read(target,S,'planHash',[],blockNumber),this.read(target,S,'recipientCount',[],blockNumber)]);
    if(!code||keccak256(code)!==manifest.codeHash||!same(onCurrency,currency)||!same(planHash,manifest.planHash)||count!==BigInt(recipients.length))throw new Error('Splitter deployment verification failed.');
    const rows=await Promise.all(recipients.map(async(r,i)=>{
      const [who,bps,claimable,released]=await Promise.all([this.read(target,S,'recipients',[BigInt(i)],blockNumber),this.read(target,S,'sharesBps',[r.address],blockNumber),this.read(target,S,'claimable',[r.address],blockNumber),this.read(target,S,'released',[r.address],blockNumber)]);
      if(!same(who,r.address)||bps!==BigInt(r.bps))throw new Error('Splitter recipient verification failed.');
      return {address:r.address,bps:r.bps,claimable,released};
    }));
    const decimals=same(currency,zeroAddress)?18:await this.read(currency,erc20Abi,'decimals',[],blockNumber);
    if(!Number.isInteger(decimals)||decimals<0||decimals>255)throw new Error('Invalid splitter currency decimals.');
    return {kind:'splitter',address:target,currency,planHash,decimals,symbol:same(currency,zeroAddress)?'ETH':QUOTES.find(q=>same(q.address,currency))?.symbol??currency,recipients:rows,status:'verified'};
  }
  async positions(raw){
    fields(raw,['account','chainId']);const account=binding(raw);await this.chain();
    const blockNumber=await this.client.getBlockNumber();await this.launchService.deployment(blockNumber);
    const records=this.launchService.store.list('confirmed',101),positions=[];
    // Bounded discovery, explicit truncation; never import Carbon's unrelated launches.
    for(const r of records.slice(0,100))try{positions.push(await this.carbonPosition(r.token,account,blockNumber));}catch(e){positions.push({kind:'carbon',token:r.token,name:r.input.name,symbol:r.input.symbol,status:'unavailable',error:e.shortMessage??e.message});}
    const deployments=[];for(const s of this.splitters)try{deployments.push(await this.splitterPosition(s,blockNumber));}catch(e){deployments.push({address:s.address,status:'unavailable',error:e.shortMessage??e.message});}
    return safe({chainId:4663,account,blockNumber,positions,truncated:records.length>100,splitters:{status:this.splitters.length?'configured':'unconfigured',deployments},
      social:{resolverConfigured:!!process.env.BAGS_API_KEY,blockers:[...(!process.env.BAGS_API_KEY?['BAGS_API_KEY']:[]),'SOCIAL_WALLET_CONTROL_ONBOARDING_UNVERIFIED'],oauthAvailable:false}});
  }
  async prepare(raw){
    fields(raw,['account','chainId','action','token','splitter','recipient']);const account=binding(raw);
    if(!['sweep','holder','creator','splitter'].includes(raw.action))throw new Error('Unknown reward action.');
    await this.chain();const preparedBlock=await this.client.getBlockNumber();await this.launchService.deployment(preparedBlock);
    let target,abi,functionName,args,expected;
    if(raw.action==='splitter'){
      if(raw.token!==undefined)throw new Error('Splitter claims do not accept a token target.');
      const recipient=address(raw.recipient,'Recipient'),manifest=this.splitters.find(s=>same(s.address,address(raw.splitter,'Splitter')));
      if(!manifest)throw new Error('Splitter is unconfigured. A verified deployment is required.');
      const p=await this.splitterPosition(manifest,preparedBlock),r=p.recipients.find(r=>same(r.address,recipient));
      if(!r)throw new Error('Recipient is not a fixed beneficiary. Redirects are not supported.');
      if(r.claimable<=0n)throw new Error('Nothing to claim for this recipient.');
      target=manifest.address;abi=S;functionName='release';args=[recipient];expected={recipient,currency:p.currency,amount:r.claimable,decimals:p.decimals,symbol:p.symbol};
    }else{
      if(raw.splitter!==undefined||raw.recipient!==undefined)throw new Error('Carbon payouts cannot be redirected.');
      const token=address(raw.token,'Token'),p=await this.carbonPosition(token,account,preparedBlock);
      if(!p.actions[raw.action])throw new Error('Nothing available for this action. Refresh balances after fees are swept and rewards vest.');
      const pool=rewardsPool(token,p.quote,this.confirmed(token).params.tickSpacing);
      abi=raw.action==='holder'?D:H;target=raw.action==='holder'?p.distributor:engine.feeHook;
      functionName=raw.action==='holder'?'withdraw':'sweep';
      args=raw.action==='holder'?[]:[pool.key];
      expected={recipient:account,currency:p.quote,decimals:p.decimals,symbol:p.quoteSymbol,poolId:p.poolId,token,distributor:p.distributor,
        amount:raw.action==='holder'?p.holderClaimable:p.pendingQuote,
        pendingToken:p.pendingToken,creator:p.creator,creatorBps:p.creatorBps};
    }
    const call={account,address:target,abi,functionName,args};
    const {result}=await this.client.simulateContract(call);
    if(!['sweep','creator'].includes(raw.action)&&(typeof result!=='bigint'||result<=0n))throw new Error('Simulation returned no payout.');
    const gas=await this.client.estimateContractGas(call),createdAt=this.now();
    const record=safe({id:randomUUID(),account,chainId:4663,action:raw.action,status:'prepared',createdAt,expiresAt:createdAt+120000,preparedBlock,
      transaction:{from:account,to:target,chainId:'0x1237',value:'0x0',data:encodeFunctionData({abi,functionName,args}),gas:toHex(gas*120n/100n)},
      expected,simulation:{result,gas},notes:['Simulation is not a payout guarantee.','Carbon has no claim deadline or minimum payout parameter.','Sweep pays the configured recipients, not the entire pot to the gas payer.']});
    this.store.prune?.(createdAt);this.store.save(record);return record;
  }
  async submit(raw){
    fields(raw,['preparation','txHash','account','chainId']);const account=binding(raw);await this.chain();
    const id=raw.preparation?.id;if(typeof id!=='string'||id.length>100)throw new Error('Provide a preparation ID.');
    const r=this.store.get(id);if(!r||r.engine||!same(r.account,account))throw new Error('Preparation not found for this wallet.');
    if(!/^0x[0-9a-f]{64}$/i.test(raw.txHash??''))throw new Error('Provide a transaction hash.');
    if(r.txHash&&!same(r.txHash,raw.txHash))throw new Error('A different transaction is already attached.');
    const tx=await this.client.getTransaction({hash:raw.txHash}),t=r.transaction;
    if(!same(tx.from,account)||!same(tx.to,t.to)||!same(tx.input,t.data)||tx.value!==0n||tx.chainId!==4663)throw new Error('Transaction differs from the prepared wallet, chain, target or calldata.');
    if(tx.blockNumber!==null&&tx.blockNumber<BigInt(r.preparedBlock))throw new Error('Transaction predates preparation.');
    const response=(status,extra={})=>({status,txHash:raw.txHash,chainId:4663,account,verified:status==='confirmed',...extra});
    Object.assign(r,this.store.attach(r.id,raw.txHash));
    let receipt;try{receipt=await this.client.getTransactionReceipt({hash:raw.txHash});}catch(e){if(e.name==='TransactionReceiptNotFoundError')return response('pending');throw e;}
    if(!same(receipt.transactionHash,raw.txHash)||!same(receipt.from,account)||!same(receipt.to,t.to)||!same(tx.blockHash,receipt.blockHash)||tx.blockNumber!==receipt.blockNumber)throw new Error('Receipt does not match the submitted transaction.');
    const block=await this.client.getBlock({blockNumber:receipt.blockNumber}),latest=await this.client.getBlockNumber();
    if(!same(block.hash,receipt.blockHash))return response('reorg');
    if(latest<receipt.blockNumber+2n)return response('confirming',{confirmations:Number(latest-receipt.blockNumber+1n),requiredConfirmations:3});
    if(receipt.status!=='success'){r.status='reverted';this.store.save(r);return response('reverted');}
    const abi=r.action==='holder'?D:r.action==='splitter'?S:H,events=logs(receipt,t.to,abi),e=r.expected;
    const isSweep=['sweep','creator'].includes(r.action),name={holder:'PayoutSent',creator:'FeeTaken',splitter:'Released',sweep:'FeeTaken'}[r.action];
    const matches=events.filter(x=>x.eventName===name&&(isSweep?same(x.args.poolId,e.poolId):same(x.args.account??x.args.to??x.args.recipient,e.recipient)));
    if(isSweep&&matches.length===0){r.status='no-op';this.store.save(r);return response('no-op',{receipt:safe({blockNumber:receipt.blockNumber,blockHash:receipt.blockHash}),reason:'No matching fee distribution; another sweep may have emptied the pool.'});}
    if(matches.length!==1)throw new Error('Expected exactly one matching reward payout event. The transaction may have become a no-op; inspect the receipt.');
    const paid=matches[0].args;
    if(!isSweep&&(paid.amount<=0n||paid.currency&&!same(paid.currency,e.currency)))throw new Error('Receipt payout is empty or in an unexpected currency.');
    if(isSweep&&paid.total<=0n)throw new Error('Sweep did not distribute fees.');
    // FeeTaken is an allocation event, not proof a restricted ERC-20 delivered
    // creator funds or holder funding. The deployed hook has no deferred ledger.
    if(isSweep){
      const transfers=logs(receipt,e.currency,erc20Abi).filter(x=>x.eventName==='Transfer'&&same(x.args.from,engine.feeHook));
      for(const [recipient,allocation] of [[e.creator,paid.toCreator],[e.distributor,paid.toHolders]]){
        const delivered=transfers.filter(x=>same(x.args.to,recipient)).reduce((n,x)=>n+x.args.value,0n);
        if(delivered<allocation){r.status='payment-unverified';this.store.save(r);return response('payment-unverified',{reason:'A configured payout was not verified as delivered. This deployed hook has no deferred recovery.',receipt:safe({blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,event:name,args:paid})});}
      }
    }
    r.status='confirmed';r.receipt=safe({blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,event:name,args:paid,events});this.store.save(r);
    return response('confirmed',{receipt:r.receipt});
  }
}
