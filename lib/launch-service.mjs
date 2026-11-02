import { randomBytes, randomUUID } from 'node:crypto';
import { createPublicClient,http,erc20Abi,encodeFunctionData,decodeEventLog,isAddress,parseUnits,formatUnits,keccak256,stringToHex,toHex,zeroAddress } from '../../app/node_modules/viem/_esm/index.js';
import { CARBON_ABI,REGISTRY_ABI,HOOK_ABI,CARBON_DEFAULT as engine } from './carbon-abi.mjs';
import snapshot from '../data/carbon-deployment.json';
import { NETWORK,QUOTES } from './config.mjs';
import { usdValuation } from './market-services.mjs';
import { usdAmount } from './usd.mjs';
import { centredOpeningCap,openingPoint,cidToBytes32,ZERO_BYTES32 } from './carbon-helpers.ts';
import { selectDexPair } from './markets.ts';

export const publicClient=()=>createPublicClient({transport:http(process.env.PLUGGED_RPC_URL||NETWORK.rpc,{timeout:20000,retryCount:1,batch:{batchSize:20,wait:10}})});
export const jsonSafe=value=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v));
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const integer=(n,min,max,label)=>{if(!Number.isInteger(n)||n<min||n>max)throw new Error(`${label}: use an integer from ${min} to ${max}.`);return n;};
const address=(value,label)=>{if(!isAddress(value??'',{strict:false})||same(value,zeroAddress))throw new Error(`${label}: enter a nonzero EVM address.`);return value.toLowerCase();};
export function launchInput(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Provide launch settings.');
  const allowed=['account','name','symbol','quote','imageCid','milestoneUsd','openingBuy','feeBps','creatorBps','feeRecipient'];
  for(const key of Object.keys(input))if(!allowed.includes(key))throw new Error(`Unsupported MVP setting: ${key}. Extended programs belong in the planner.`);
  const text=(key,max)=>{if(typeof input[key]!=='string'||!input[key].trim()||input[key].length>max)throw new Error(`${key}: required, maximum ${max} characters.`);return input[key].trim();};
  const name=text('name',64),symbol=text('symbol',12);
  if(!/^[\x20-\x7e]+$/.test(name)||!/[A-Za-z0-9]/.test(name)||!/^[A-Za-z0-9]{1,12}$/.test(symbol))throw new Error('Use a printable name and an alphanumeric ticker.');
  const account=address(input.account,'Wallet'),quote=QUOTES.find(q=>same(q.address,input.quote)&&!q.native);
  if(!quote)throw new Error('Choose a configured ERC-20 pair. ETH funds the wallet; it is not a Carbon quote token.');
  const imageCid=text('imageCid',100),image=cidToBytes32(imageCid);
  // Carbon stores a sha2-256 digest. Restrict accepted encodings to its two supported codecs.
  if(!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafkrei[a-z2-7]{52}|bafybei[a-z2-7]{52})$/.test(imageCid)||!image.ok||image.digest===ZERO_BYTES32)throw new Error('Provide an IPFS sha2-256 image CID (Qm…, bafybei… or bafkrei…).');
  const milestoneUsd=input.milestoneUsd??'40000';if(usdAmount(milestoneUsd)<=250000n)throw new Error('Milestone must exceed $2,500.');
  const openingBuy=text('openingBuy',80);
  if(!/^\d{1,30}(\.\d{1,18})?$/.test(openingBuy)||(openingBuy.split('.')[1]?.length??0)>quote.decimals||parseUnits(openingBuy,quote.decimals)<=0n)throw new Error('Enter a positive opening purchase in quote units, within token precision.');
  return {account,name,symbol,quote:quote.address,imageCid,milestoneUsd,openingBuy,
    feeBps:integer(input.feeBps??200,1,1000,'Trading fee (bps)'),creatorBps:integer(input.creatorBps??10000,0,10000,'Creator share (bps)'),
    feeRecipient:address(input.feeRecipient||account,'Fee recipient')};
}
export function buildCarbonParams(input,price,salt) {
  const quote=QUOTES.find(q=>q.address===input.quote),image=cidToBytes32(input.imageCid);
  return {name:input.name,symbol:input.symbol,supply:parseUnits('1000000000',18),pair:quote.address,
    openingMarketCap:centredOpeningCap(BigInt(price.openingQuoteRaw),60),graduationThreshold:BigInt(price.milestoneQuoteRaw),
    feeBps:input.feeBps,sellFeeBps:0,burnBps:0,vestDuration:0n,vestCliff:0n,creatorBps:input.creatorBps,maxWalletBps:300,tickSpacing:60,
    devBuyPairAmount:parseUnits(input.openingBuy,quote.decimals),salt,minPushPayout:1n,minShareForQueue:parseUnits('1000',18),
    rewardCurrency:zeroAddress,feeRecipient:input.feeRecipient,referrer:zeroAddress,openingWindow:0,openingFeeBps:0,
    metadata:{imageCid:image.digest,bannerCid:ZERO_BYTES32,infoCid:ZERO_BYTES32}};
}
export function economicFingerprint(input) {
  // Wallets, image and opening purchase do not let a copy evade the economic identity rule.
  return keccak256(stringToHex(JSON.stringify([input.name.replace(/ +/g,' ').trim().toUpperCase(),input.symbol.toUpperCase(),input.quote,
    usdAmount(input.milestoneUsd).toString(),input.feeBps,input.creatorBps,300,'1000000000','2500'])));
}
export class LaunchService {
  constructor({store,client=publicClient(),price=usdValuation,now=Date.now,fetcher=fetch}={}) {Object.assign(this,{store,client,price,now,fetcher});this.dexCache=new Map();}
  async deployment(blockNumber) {
    if(await this.client.getChainId()!==4663)throw new Error('RPC must be Robinhood chain 4663.');
    await Promise.all(Object.values(snapshot.hashes).map(async expected=>{
      const code=await this.client.getCode({address:expected.address,blockNumber});
      if(!code||keccak256(code)!==expected.codeHash)throw new Error(`Engine code changed or unavailable: ${expected.address}. Re-verify deployment.`);
    }));
    const [floor,max]=await Promise.all(['PLATFORM_VOLUME_BPS','MAX_FEE_BPS'].map(functionName=>this.client.readContract({address:engine.feeHook,abi:HOOK_ABI,functionName,blockNumber})));
    return {platformVolumeBps:floor,maxFeeBps:max};
  }
  async prepare(raw) {
    const input=launchInput(raw),fingerprint=economicFingerprint(input);
    if(this.store.duplicate(fingerprint))throw new Error('An identical name, ticker and economics already launched through Plugged.');
    const blockNumber=await this.client.getBlockNumber(),fees=await this.deployment(blockNumber);
    if(input.feeBps<=fees.platformVolumeBps||input.feeBps>fees.maxFeeBps)throw new Error(`Carbon requires a fee above ${fees.platformVolumeBps/100}% and at most ${fees.maxFeeBps/100}%.`);
    const read=(target,abi,functionName,args=[])=>this.client.readContract({address:target,abi,functionName,args,blockNumber});
    const [approved,config,decimals,balance,allowance]=await Promise.all([
      read(engine.pairRegistry,REGISTRY_ABI,'isApproved',[input.quote]),read(engine.pairRegistry,REGISTRY_ABI,'pairConfig',[input.quote]),
      read(input.quote,erc20Abi,'decimals'),
      read(input.quote,erc20Abi,'balanceOf',[input.account]),read(input.quote,erc20Abi,'allowance',[input.account,engine.launcher]),
    ]);
    if(!approved)throw new Error('This pair needs the registry owner’s approval. Its unsigned setup transaction is in the operator manifest.');
    const quote=QUOTES.find(q=>q.address===input.quote);
    if(decimals!==quote.decimals||config.tokenDecimals!==decimals)throw new Error('Token decimals differ from the catalog or registry. Operator correction required.');
    // This older live launcher has no minDevBuyFor getter (the current source does).
    // This is Plugged's dust floor, not a claimed on-chain constant; launch simulation is authoritative.
    const minimum=decimals>=6?10n**BigInt(decimals-6):1n;
    const price=await this.price(input.quote,input.milestoneUsd,{useCache:false});
    if(price.quote!==input.quote||price.decimals!==decimals||price.openingMarketCapUsd!=='2500'||Date.parse(price.expiresAt)<=this.now())throw new Error('Fresh USD conversion is unavailable.');
    const params=buildCarbonParams(input,price,`0x${randomBytes(32).toString('hex')}`);
    // At the hard opening floor, <=2% FDV of quote cannot buy 3% of supply. Leave room for ticks/fees.
    if(params.devBuyPairAmount<minimum||params.devBuyPairAmount>params.openingMarketCap*200n/10000n)throw new Error(`Opening purchase must be ${formatUnits(minimum,decimals)}–${formatUnits(params.openingMarketCap*200n/10000n,decimals)} ${quote.symbol} (Plugged's creator cap).`);
    const predicted=await read(engine.launcher,CARBON_ABI,'predictTokenAddress',[params.salt]);
    const point=openingPoint(params.supply,params.openingMarketCap,predicted.toLowerCase()<input.quote,60);
    const transaction={from:input.account,to:engine.launcher,chainId:NETWORK.hexId,value:'0x0',data:encodeFunctionData({abi:CARBON_ABI,functionName:'launch',args:[params]})};
    let next='fund',approval=null,simulation=null;
    if(balance>=params.devBuyPairAmount){
      if(allowance<params.devBuyPairAmount){
        next='approve';
        // Nonzero allowances are reset first, compatible with USDT-like tokens.
        const amount=allowance>0n?0n:params.devBuyPairAmount;
        approval={from:input.account,to:input.quote,chainId:NETWORK.hexId,value:'0x0',data:encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[engine.launcher,amount]})};
        const sim=await this.client.simulateContract({account:input.account,address:input.quote,abi:erc20Abi,functionName:'approve',args:[engine.launcher,amount]});
        if(sim.result!==true)throw new Error('Quote token refused approval.');
      }else{
        const {result}=await this.client.simulateContract({account:input.account,address:engine.launcher,abi:CARBON_ABI,functionName:'launch',args:[params]});
        if(!same(result[0],predicted))throw new Error('Simulated token address differs from prediction.');
        const gas=await this.client.estimateContractGas({account:input.account,address:engine.launcher,abi:CARBON_ABI,functionName:'launch',args:[params]});
        transaction.gas=toHex(gas*120n/100n);simulation={token:result[0].toLowerCase(),poolId:result[1],gas:gas.toString()};next='launch';
      }
    }
    const createdAt=this.now(),record=jsonSafe({id:randomUUID(),fingerprint,status:'prepared',createdAt,expiresAt:Date.parse(price.expiresAt),preparedBlock:blockNumber,
      input,params,transaction,approval,simulation,predicted:predicted.toLowerCase(),price,fees,opening:point,
      balance:balance.toString(),allowance:allowance.toString(),required:params.devBuyPairAmount.toString(),next});
    if(record.expiresAt<=createdAt)throw new Error('Price expired during preparation. Retry.');
    this.store.prune(createdAt);this.store.save(record);return this.view(record);
  }
  view(record) {
    return {...record,transaction:record.next==='launch'?record.transaction:null,
      notes:['Funding, approval and launch are separate wallet transactions.','Carbon has no launch deadline or minimum token output parameter; review promptly.','The 3% ordinary-wallet cap has engine exemptions; Plugged limits its creator purchase.','USD prices are provider estimates, not a guaranteed USD peg.']};
  }
  async submit(id,txHash) {
    const record=this.store.get(id);if(!record||record.engine)throw new Error('Launch preparation not found.');
    if(!/^0x[0-9a-f]{64}$/i.test(txHash??''))throw new Error('Provide a transaction hash.');
    if(record.txHash&&!same(record.txHash,txHash))throw new Error('A different transaction is already attached.');
    if(!record.simulation)throw new Error('Launch was not simulated. Prepare it after funding and approval.');
    const tx=await this.client.getTransaction({hash:txHash});
    if(!same(tx.from,record.input.account)||!same(tx.to,engine.launcher)||!same(tx.input,record.transaction.data)||tx.value!==0n||tx.chainId!==4663)throw new Error('Transaction does not match the prepared wallet, engine, calldata or chain.');
    if(tx.blockNumber!==null&&tx.blockNumber<BigInt(record.preparedBlock))throw new Error('Transaction predates this preparation.');
    if(!record.txHash){record.txHash=txHash.toLowerCase();record.status='submitted';this.store.save(record);}
    return this.confirm(record);
  }
  async confirm(record) {
    let receipt;
    try {receipt=await this.client.getTransactionReceipt({hash:record.txHash});}
    catch(error){if(error.name==='TransactionReceiptNotFoundError')return this.view(record);throw error;}
    if(receipt.status!=='success'){record.status='reverted';this.store.save(record);return this.view(record);}
    const block=await this.client.getBlock({blockNumber:receipt.blockNumber}),latest=await this.client.getBlockNumber();
    if(!same(block.hash,receipt.blockHash)||latest<receipt.blockNumber+2n){record.status='submitted';this.store.save(record);return this.view(record);}
    const events=receipt.logs.filter(l=>same(l.address,engine.launcher)).flatMap(log=>{try{return [decodeEventLog({abi:CARBON_ABI,data:log.data,topics:log.topics})];}catch{return [];}}).filter(e=>e.eventName==='Launched');
    if(events.length!==1)throw new Error('Expected exactly one Carbon launch event.');
    const e=events[0].args,p=record.params;
    if(!same(e.creator,record.input.account)||!same(e.pair,p.pair)||!same(e.token,record.predicted)||!same(e.poolId,record.simulation.poolId)||e.supply!==BigInt(p.supply)||e.openingMarketCap!==BigInt(p.openingMarketCap)||e.feeBps!==p.feeBps)throw new Error('Launch event differs from the prepared economics.');
    const duplicate=this.store.duplicate(record.fingerprint);
    record.status=duplicate&&duplicate!==record.id?'duplicate':'confirmed';record.token=e.token.toLowerCase();record.poolId=e.poolId;
    record.blockNumber=receipt.blockNumber.toString();record.blockHash=receipt.blockHash;record.launchedAt=Number(block.timestamp);this.store.save(record);return this.view(record);
  }
  async reconcile() {
    for(const record of this.store.list('submitted',20))try{await this.confirm(record);}catch(error){console.error('Launch reconciliation:',record.id,error.shortMessage??error.message);}
  }
  async markets() {
    const records=this.store.list('confirmed',100),tokens=[];
    for(const record of records){
      // Never serve a listing from a block removed by a reorganization.
      const block=await this.client.getBlock({blockNumber:BigInt(record.blockNumber)});
      if(!same(block.hash,record.blockHash)){record.status='submitted';this.store.save(record);continue;}
      tokens.push({address:record.token,name:record.input.name,symbol:record.input.symbol,quote:record.input.quote,quoteSymbol:QUOTES.find(q=>q.address===record.input.quote)?.symbol,
        launchedAt:record.launchedAt,maxWalletBps:300,marketCapUsd:null,volume24hUsd:null,change24h:null,dexPair:null,txHash:record.txHash,poolId:record.poolId});
    }
    // Enrich only already-confirmed Plugged launches. Provider data never creates listings.
    for(let offset=0;offset<tokens.length;offset+=30){
      const batch=tokens.slice(offset,offset+30),key=batch.map(t=>t.address).join(',');
      let cached=this.dexCache.get(key);
      if(!cached||this.now()-cached.at>30000){
        try{const r=await this.fetcher(`https://api.dexscreener.com/tokens/v1/robinhood/${key}`,{signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error('DEX indexing unavailable');const pairs=await r.json();if(!Array.isArray(pairs))throw new Error('Invalid DEX response');cached={at:this.now(),pairs};this.dexCache.set(key,cached);}catch{cached={pairs:[]};}
      }
      for(const token of batch){const p=selectDexPair(cached.pairs.filter(p=>same(p?.quoteToken?.address,token.quote)&&same(p?.pairAddress,token.poolId)),token.address);if(!p)continue;
        const number=v=>typeof v==='number'&&Number.isFinite(v)?v:null;token.dexPair=p.pairAddress;token.marketCapUsd=number(p.fdv);token.volume24hUsd=number(p.volume?.h24);token.change24h=number(p.priceChange?.h24);
      }
    }
    return {tokens,warnings:[],total:String(tokens.length),sampled:tokens.length,blockNumber:records[0]?.blockNumber??null,observedAt:new Date(this.now()).toISOString(),source:'plugged',chainId:4663,status:'ready'};
  }
}
