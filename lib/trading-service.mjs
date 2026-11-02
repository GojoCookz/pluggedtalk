import { randomUUID } from 'node:crypto';
import { encodeAbiParameters,encodeFunctionData,decodeEventLog,erc20Abi,isAddress,keccak256,parseAbiParameters,parseUnits,toHex,zeroAddress } from '../../app/node_modules/viem/_esm/index.js';
import { CARBON_DEFAULT as engine } from './carbon-abi.mjs';
import { NETWORK,QUOTES } from './config.mjs';
import { TRADING_ABI,TRADING_ROUTER_HASH,POOL_KEY } from './trading-abi.mjs';
import { tradingErrorCode } from './trading-errors.mjs';
export { tradingErrorCode } from './trading-errors.mjs';

const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const safe=value=>JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v));
const fail=(message,code)=>{const error=new Error(message);error.code=code||tradingErrorCode(error);throw error;};
const address=value=>isAddress(value??'',{strict:false})&&!same(value,zeroAddress)?value.toLowerCase():fail('Enter a nonzero wallet/token address.');
const integer=(value,min,max,label)=>Number.isInteger(value)&&value>=min&&value<=max?value:fail(`${label}: use an integer from ${min} to ${max}.`);
function fields(input,allowed){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('Provide a JSON object.');
  if(Object.keys(input).some(key=>!allowed.includes(key)))fail('Unsupported trading setting.');
}
export function tradingAmount(value,decimals){
  if(typeof value!=='string'||!/^\d{1,39}(\.\d{1,18})?$/.test(value)||(value.split('.')[1]?.length??0)>decimals)fail('Enter a positive decimal amount within token precision.');
  const raw=parseUnits(value,decimals);
  if(raw<=0n||raw>(1n<<127n)-1n)fail('Amount is outside the supported exact-input range.');
  return raw;
}
export function tradingPool(record){
  const token=address(record.token),pair=address(record.input.quote),first=token<pair;
  if(!same(record.params.pair,pair)||token===pair)fail('Launch pair does not match its verified record.');
  const key={currency0:first?token:pair,currency1:first?pair:token,fee:0,tickSpacing:record.params.tickSpacing,hooks:engine.feeHook};
  if(key.tickSpacing!==60||!same(keccak256(encodeAbiParameters(parseAbiParameters(POOL_KEY),[key])),record.poolId))fail('Pool identity does not match the verified launch.');
  return key;
}
const txFor=(account,to,data)=>({from:account,to,chainId:NETWORK.hexId,value:'0x0',data});
const notFound=e=>['TransactionReceiptNotFoundError','TransactionNotFoundError'].includes(e?.name);

/** Wallet-only execution. No private key, write client, indexer discovery or server broadcast. */
export class TradingService {
  constructor({launchService,now=Date.now}={}){
    if(!launchService?.store?.db)fail('TradingService requires the durable LaunchService store.');
    this.launchService=launchService;this.client=launchService.client;this.db=launchService.store.db;this.now=now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS plugged_trades (id TEXT PRIMARY KEY,created INTEGER NOT NULL,tx_hash TEXT UNIQUE,data TEXT NOT NULL);`);
  }
  save(record){
    this.db.query(`INSERT INTO plugged_trades VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET tx_hash=excluded.tx_hash,data=excluded.data`).run(record.id,record.createdAt,record.txHash??null,JSON.stringify(record));
    return record;
  }
  get(id){
    if(typeof id!=='string'||! /^[0-9a-f-]{36}$/i.test(id))fail('Trade review not found. Review again.');
    const row=this.db.query('SELECT data FROM plugged_trades WHERE id=?').get(id);
    if(!row)fail('Trade review not found. Review again.');
    const record=JSON.parse(row.data);
    // Engines never share reviews: a baseline review cannot be prepared through another router.
    if((record.engine??null)!==(this.engine??null))fail('Trade review not found. Review again.');
    return record;
  }
  get quoteFields(){return ['token','account','side','amount','slippageBps','reviewSeconds'];}
  get balanceFields(){return ['token','account'];}
  view(record){
    const {transaction,...rest}=record;
    return {...rest,transaction:null,capabilities:{minimumOutput:true,onchainDeadline:false},
      notes:['Minimum output is enforced on-chain. Review expiry is application-only; signed swaps do not expire.','Approval and trade are separate transactions. ETH funding is separate.','Quotes include the live hook behavior. Gas cost is an estimate, not a guaranteed fee.']};
  }
  async launch(token){
    // Exact token match in Plugged's store only. Never enumerate the Carbon launcher.
    const row=this.db.query("SELECT data FROM launches WHERE status='confirmed' AND coalesce(json_extract(data,'$.engine'),'carbon-baseline-v1')='carbon-baseline-v1' AND lower(json_extract(data,'$.token'))=? LIMIT 1").get(address(token));
    if(!row)fail('This token is not a confirmed Plugged launch.');
    const record=JSON.parse(row.data);
    // Revalidate exact original tx, event economics, receipt canonicality and confirmations.
    const checked=await this.launchService.submit(record.id,record.txHash);
    if(checked.status!=='confirmed'||!same(checked.token,token))fail('Launch confirmation changed. Refresh the market.');
    tradingPool(checked);return checked;
  }
  async snapshot(token,account){
    const launch=await this.launch(token),blockNumber=await this.client.getBlockNumber();
    await this.launchService.deployment(blockNumber);
    // Independent immutable pin: a regenerated deployment manifest cannot silently change trading.
    const code=await this.client.getCode({address:engine.tradeRouter,blockNumber});
    if(!code||keccak256(code)!==TRADING_ROUTER_HASH)fail('Trading router bytecode changed. Re-verification required.');
    const read=(target,abi,functionName,args=[])=>this.client.readContract({address:target,abi,functionName,args,blockNumber});
    const [manager,tokenDecimals,quoteDecimals,tokenBalance,quoteBalance,tokenAllowance,quoteAllowance,nativeBalance,block]=await Promise.all([
      read(engine.tradeRouter,TRADING_ABI,'poolManager'),read(token,erc20Abi,'decimals'),read(launch.input.quote,erc20Abi,'decimals'),
      read(token,erc20Abi,'balanceOf',[account]),read(launch.input.quote,erc20Abi,'balanceOf',[account]),
      read(token,erc20Abi,'allowance',[account,engine.tradeRouter]),read(launch.input.quote,erc20Abi,'allowance',[account,engine.tradeRouter]),
      this.client.getBalance({address:account,blockNumber}),this.client.getBlock({blockNumber}),
    ]);
    const quote=QUOTES.find(q=>same(q.address,launch.input.quote)&&!q.native);
    if(!same(manager,engine.poolManager)||tokenDecimals!==18||!quote||quote.decimals!==quoteDecimals)fail('Pool deployment or token precision changed. Re-verification required.');
    if(!block.hash||Math.abs(this.now()/1000-Number(block.timestamp))>120)fail('RPC head is stale. Retry with a healthy Robinhood RPC.');
    return {launch,key:tradingPool(launch),blockNumber,blockHash:block.hash,blockTimestamp:block.timestamp,
      token:{address:token,symbol:launch.input.symbol,decimals:tokenDecimals,balance:tokenBalance,allowance:tokenAllowance},
      quote:{address:quote.address,symbol:quote.symbol,decimals:quoteDecimals,balance:quoteBalance,allowance:quoteAllowance},nativeBalance};
  }
  async balances(input){
    fields(input,this.balanceFields);const token=address(input.token),account=address(input.account),s=await this.snapshot(token,account,input);
    return safe({account,token:s.token,quote:s.quote,nativeBalance:s.nativeBalance,blockNumber:s.blockNumber,blockHash:s.blockHash,chainId:4663,router:s.router??engine.tradeRouter,...(s.extra??{}),capabilities:{minimumOutput:true,onchainDeadline:false}});
  }
  async quote(input){
    fields(input,this.quoteFields);
    const token=address(input.token),account=address(input.account),side=input.side;
    if(!['buy','sell'].includes(side))fail('Choose buy or sell.');
    const slippageBps=integer(input.slippageBps??50,0,500,'Slippage (bps)'),reviewSeconds=integer(input.reviewSeconds??60,30,120,'Review validity (seconds)');
    const s=await this.snapshot(token,account,input),router=s.router??engine.tradeRouter,asset=side==='buy'?s.quote:s.token,output=side==='buy'?s.token:s.quote,amountIn=tradingAmount(input.amount,asset.decimals);
    const zeroForOne=same(asset.address,s.key.currency0),createdAt=this.now();
    let next='fund',expectedOutput=null,minimumOutput=null,approvalAmount=null;
    if(asset.balance>=amountIn){
      if(asset.allowance<amountIn){next='approve';approvalAmount=asset.allowance>0n?0n:amountIn;}
      else{
        const {result}=await this.client.simulateContract({account,address:router,abi:TRADING_ABI,functionName:'swap',args:[s.key,zeroForOne,amountIn,0n,account],blockNumber:s.blockNumber});
        expectedOutput=result;minimumOutput=result*BigInt(10000-slippageBps)/10000n;
        if(minimumOutput<=0n)fail('Trade output is too small or liquidity is unavailable. Try another amount.');
        next='trade';
      }
    }
    const record=safe({id:randomUUID(),status:'review',createdAt,expiresAt:createdAt+reviewSeconds*1000,preparedBlock:s.blockNumber,
      token,account,side,amount:input.amount,amountIn,slippageBps,reviewSeconds,key:s.key,poolId:s.poolId??s.launch.poolId,zeroForOne,router,chainId:4663,...(s.extra??{}),
      inputAsset:asset,outputAsset:output,nativeBalance:s.nativeBalance,expectedOutput,minimumOutput,approvalAmount,next,transaction:null,blockHash:s.blockHash});
    // Keep all signed/submitted records. Old unsigned reviews alone can be discarded.
    this.db.query("DELETE FROM plugged_trades WHERE tx_hash IS NULL AND created<? AND json_extract(data,'$.status')='review'").run(createdAt-86400000);
    this.save(record);return this.view(record);
  }
  async prepare(input){
    fields(input,['id','account']);const record=this.get(input.id),account=address(input.account);
    if(!same(account,record.account))fail('Wallet changed. Review again.');
    if(record.txHash)fail('This transaction was already submitted. Check confirmation.');
    if(this.now()>=record.expiresAt)fail('Review expired. Review again.');
    if(!['approve','trade'].includes(record.next))fail('Fund the input asset, then review again.');
    const s=await this.snapshot(record.token,account,record),asset=record.side==='buy'?s.quote:s.token,amountIn=BigInt(record.amountIn);
    if(!same(s.router??engine.tradeRouter,record.router)||!same(s.poolId??s.launch.poolId,record.poolId))fail('Pool or router changed. Review again.');
    if(asset.balance<amountIn)fail('Insufficient input balance. Fund the wallet, then review again.');
    let call,data,to;
    if(record.next==='approve'){
      const expected=asset.allowance>0n?0n:amountIn;
      if(asset.allowance>=amountIn||expected!==BigInt(record.approvalAmount))fail('Allowance changed. Review again.');
      to=asset.address;call={account,address:to,abi:erc20Abi,functionName:'approve',args:[record.router,expected]};
      const {result}=await this.client.simulateContract({...call,blockNumber:s.blockNumber});
      if(result!==true)fail('Token refused approval.');
    }else{
      if(asset.allowance<amountIn)fail('Approval changed. Review again.');
      to=record.router;call={account,address:to,abi:TRADING_ABI,functionName:'swap',args:[s.key,record.zeroForOne,amountIn,BigInt(record.minimumOutput),account]};
      // Never silently refresh the user's minimum after review. A moved price must fail.
      const {result}=await this.client.simulateContract({...call,blockNumber:s.blockNumber});
      if(result<BigInt(record.minimumOutput))fail('Minimum output is no longer available. Review again.');
    }
    data=encodeFunctionData(call);
    const [estimate,gasPrice]=await Promise.all([this.client.estimateContractGas(call),this.client.getGasPrice()]);
    const gas=(estimate*120n+99n)/100n,gasCost=gas*gasPrice;
    if(s.nativeBalance<gasCost)fail('Insufficient native ETH for estimated gas. Fund ETH separately, then review again.');
    if(this.now()>=record.expiresAt)fail('Review expired during simulation. Review again.');
    record.inputAsset=safe(asset);record.outputAsset=safe(record.side==='buy'?s.token:s.quote);record.nativeBalance=s.nativeBalance.toString();record.simulationBlock=s.blockNumber.toString();
    record.transaction={...txFor(account,to,data),gas:toHex(gas)};record.status='prepared';record.simulatedAt=this.now();record.gasEstimate=estimate.toString();record.gasCostEstimate=gasCost.toString();
    this.save(record);return {...this.view(record),transaction:record.transaction};
  }
  async submit(input){
    fields(input,['id','txHash']);const record=this.get(input.id),hash=input.txHash;
    if(!/^0x[0-9a-f]{64}$/i.test(hash??''))fail('Paste the complete transaction hash.');
    if(!record.transaction)fail('Trade was not prepared and simulated.');
    if(record.txHash&&!same(record.txHash,hash))fail('A different hash is already attached to this review.');
    let tx;try{tx=await this.client.getTransaction({hash});}catch(e){if(notFound(e))return {...this.view(record),status:'not_found',txHash:hash};throw e;}
    const expected=record.cancellation?{to:record.account,data:'0x'}:record.transaction;
    if(tx.chainId!==4663||!Number.isSafeInteger(tx.nonce)||tx.nonce<0||!same(tx.from,record.account)||!same(tx.to,expected.to)||!same(tx.input,expected.data)||tx.value!==0n)fail('Transaction differs from the reviewed wallet, chain, recipient or calldata.');
    if(tx.blockNumber!==null&&tx.blockNumber<BigInt(record.preparedBlock))fail('Transaction predates this review.');
    if(record.nonce!==undefined&&String(tx.nonce)!==record.nonce)fail('Transaction nonce differs from the reviewed submission.');
    record.txHash=hash.toLowerCase();record.nonce=String(tx.nonce);record.status='submitted';this.save(record);
    let receipt;try{receipt=await this.client.getTransactionReceipt({hash});}catch(e){if(notFound(e))return this.view(record);throw e;}
    const [block,latest]=await Promise.all([this.client.getBlock({blockNumber:receipt.blockNumber}),this.client.getBlockNumber()]);
    if(!same(block.hash,receipt.blockHash)||!same(tx.blockHash,receipt.blockHash)||latest<receipt.blockNumber+2n)return this.view(record);
    if(receipt.status!=='success'){record.status='reverted';this.save(record);return this.view(record);}
    if(record.next==='trade'&&!record.cancellation){
      const events=receipt.logs.filter(l=>same(l.address,record.router)).flatMap(log=>{try{return [decodeEventLog({abi:TRADING_ABI,data:log.data,topics:log.topics,strict:true})];}catch{return [];}}).filter(e=>e.eventName==='Traded');
      if(events.length!==1)fail('Expected exactly one router trade event.');
      const e=events[0].args;
      if(!same(keccak256(encodeAbiParameters(parseAbiParameters(POOL_KEY),[e.key])),record.poolId)||!same(e.trader,record.account)||!same(e.recipient,record.account)||e.zeroForOne!==record.zeroForOne||e.amountIn!==BigInt(record.amountIn)||e.amountOut<BigInt(record.minimumOutput))fail('Trade event differs from the reviewed trade.');
      record.actualOutput=e.amountOut.toString();
    }
    record.status=record.cancellation?'cancelled':'confirmed';record.blockNumber=receipt.blockNumber.toString();record.blockHash=receipt.blockHash;this.save(record);return this.view(record);
  }
  async replacement(record,txHash,replaces){
    if(!/^0x[0-9a-f]{64}$/i.test(txHash??''))fail('Paste the complete transaction hash.');
    const originalHash=record.txHash||replaces;
    if(!record.transaction||!/^0x[0-9a-f]{64}$/i.test(originalHash??''))fail('Original transaction is required for replacement verification.','TRADING_REPLACEMENT');
    // Recover the original nonce from its previously verified submission, or still-visible RPC tx.
    if(record.nonce===undefined){
      const original=await this.client.getTransaction({hash:originalHash});
      if(original.chainId!==4663||!same(original.from,record.account)||!same(original.to,record.transaction.to)||!same(original.input,record.transaction.data)||original.value!==0n)fail('Original transaction context differs.');
      record.nonce=String(original.nonce);
    }
    let receipt;
    try{receipt=await this.client.getTransactionReceipt({hash:originalHash});}catch(e){if(!notFound(e))throw e;}
    if(receipt){const block=await this.client.getBlock({blockNumber:receipt.blockNumber});if(same(block.hash,receipt.blockHash))fail('Original transaction is already mined.','TRADING_ORIGINAL_MINED');}
    const candidate=await this.client.getTransaction({hash:txHash});
    const cancellation=same(candidate.to,record.account)&&candidate.input==='0x'&&candidate.value===0n;
    const speedup=same(candidate.to,record.transaction.to)&&same(candidate.input,record.transaction.data)&&candidate.value===0n;
    if(candidate.chainId!==4663||!same(candidate.from,record.account)||String(candidate.nonce)!==record.nonce||(!cancellation&&!speedup))fail('Unverified replacement transaction.','TRADING_REPLACEMENT');
    record.previousHashes=[...(record.previousHashes||[]),originalHash];record.txHash=txHash.toLowerCase();record.cancellation=cancellation;record.status='submitted';
    delete record.actualOutput;delete record.blockNumber;delete record.blockHash;
    this.save(record);return this.submit({id:record.id,txHash});
  }
  async status(input){
    fields(input,['id','txHash','replaces']);const record=this.get(input.id),txHash=input.txHash??record.txHash;
    if(txHash&&(record.txHash?!same(record.txHash,txHash):input.replaces&&!same(input.replaces,txHash)))return this.replacement(record,txHash,input.replaces);
    return txHash?this.submit({id:input.id,txHash}):this.view(record);
  }
}
