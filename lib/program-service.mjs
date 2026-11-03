import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { erc20Abi,encodeFunctionData,decodeEventLog,isAddress,parseUnits,keccak256,toHex,zeroAddress } from '../../app/node_modules/viem/_esm/index.js';
import { CAMPAIGN_ABI,CASHBACK_ABI } from './program-service-abi.mjs';
import { ProgramStore } from './program-service-store.mjs';
import { uint256,verifyFeeVoucher } from './cashback.mjs';

const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const safe=x=>JSON.parse(JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v));
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const addr=(v,label='Wallet',zero=false)=>{
  if(!isAddress(v??'',{strict:false})||(!zero&&same(v,zeroAddress)))fail(`${label}: enter a valid nonzero EVM address.`);
  return v.toLowerCase();
};
const hash=(v,label)=>{if(!/^0x[\da-f]{64}$/i.test(v??''))fail(`${label}: expected a 32-byte hash.`);return v.toLowerCase();};
const keys=(o,allowed)=>{if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!allowed.includes(k)))fail('Unsupported request fields.');};
const abiFor=p=>p.kind==='campaign'?CAMPAIGN_ABI:CASHBACK_ABI;
const notes=['Campaign escrow and cashback budgets are independent.','A fixed beneficiary does not verify charity identity, endorsement or tax deductibility.','Preparations expire off-chain; already signed campaign calldata has only the contract deadline.'];

export function programManifest(raw) {
  if(!Array.isArray(raw)||raw.length>100)fail('Program manifest must contain at most 100 deployments.');
  const ids=new Set(),addresses=new Set();
  return raw.map(p=>{
    if(!p||!['campaign','cashback'].includes(p.kind)||! /^[a-zA-Z0-9_-]{1,64}$/.test(p.id??''))fail('Invalid program manifest identity.');
    if(![4663,31337].includes(p.chainId)||(p.chainId===31337)!==(p.localTest===true))fail('Local test programs require chain 31337; production requires 4663.');
    if(!Number.isInteger(p.decimals)||p.decimals<0||p.decimals>36)fail('Unsupported currency decimals.');
    const r={id:p.id,kind:p.kind,name:String(p.name||p.id).slice(0,100),chainId:p.chainId,localTest:p.localTest===true,address:addr(p.address,'Program'),codeHash:hash(p.codeHash,'Program code hash'),
      deploymentBlock:uint256(p.deploymentBlock,'Deployment block').toString(),deploymentBlockHash:hash(p.deploymentBlockHash,'Deployment block hash'),currency:addr(p.currency,'Currency',true),decimals:p.decimals,symbol:String(p.symbol||'units').slice(0,20),launchId:p.launchId};
    if(same(r.currency,zeroAddress)){if(r.decimals!==18)fail('Native ETH requires 18 decimals.');r.symbol='ETH';}
    else r.currencyCodeHash=hash(p.currencyCodeHash,'Currency code hash');
    if(!r.localTest&&(typeof r.launchId!=='string'||!r.launchId))fail('Production program must reference a confirmed Plugged launch.');
    if(p.kind==='campaign')Object.assign(r,{beneficiary:addr(p.beneficiary,'Beneficiary'),goal:uint256(p.goal,'Goal').toString(),deadline:uint256(p.deadline,'Deadline').toString()});
    else Object.assign(r,{attestor:addr(p.attestor,'Attestor'),rebateBps:uint256(p.rebateBps,'Rebate').toString(),budget:uint256(p.budget,'Budget').toString()});
    if(p.kind==='campaign'&&(r.goal==='0'||same(r.beneficiary,r.address)))fail('Invalid campaign configuration.');
    if(p.kind==='cashback'&&(r.budget==='0'||BigInt(r.rebateBps)<1n||BigInt(r.rebateBps)>10000n))fail('Invalid cashback configuration.');
    if(ids.has(r.id)||addresses.has(`${r.chainId}:${r.address}`))fail('Duplicate program identity or address.');
    ids.add(r.id);addresses.add(`${r.chainId}:${r.address}`);return Object.freeze(r);
  });
}

export class ProgramService {
  constructor({launchService,client=launchService?.client,manifest,store,enabled=process.env.PLUGGED_PROGRAMS_ENABLED==='true',now=Date.now,voucherProvider=null}={}) {
    this.client=client;this.launchService=launchService;this.now=now;this.enabled=enabled;this.voucherProvider=voucherProvider;
    this.manifest=programManifest(manifest??(process.env.PLUGGED_PROGRAMS_MANIFEST?JSON.parse(readFileSync(process.env.PLUGGED_PROGRAMS_MANIFEST,'utf8')):[]));
    this.store=store??new ProgramStore(process.env.PLUGGED_PROGRAMS_DB_PATH||fileURLToPath(new URL('../runtime/programs.sqlite',import.meta.url)));
  }
  entry(id){return this.manifest.find(p=>p.id===id)??fail('Verified program not configured.',404);}
  async deployment(p,blockNumber) {
    if(!this.client)fail('Program RPC is unavailable.',503);
    if(await this.client.getChainId()!==p.chainId)fail('Program RPC chain does not match the verified manifest.',503);
    if(blockNumber<BigInt(p.deploymentBlock))fail('Program is not deployed at this block.',503);
    const origin=await this.client.getBlock({blockNumber:BigInt(p.deploymentBlock)});
    if(!same(origin.hash,p.deploymentBlockHash))fail('Program deployment was reorganized. Operator verification required.',503);
    const code=await this.client.getCode({address:p.address,blockNumber});
    if(!code||code==='0x'||!same(keccak256(code),p.codeHash))fail('Program bytecode is absent or changed. Operator verification required.',503);
    if(!p.localTest){
      const launch=this.launchService?.store?.get(p.launchId);
      if(!launch||launch.status!=='confirmed')fail('Associated Plugged launch is not confirmed.',503);
      const block=await this.client.getBlock({blockNumber:BigInt(launch.blockNumber)});
      if(!same(block.hash,launch.blockHash))fail('Associated launch was reorganized.',503);
    }
    if(!same(p.currency,zeroAddress)){
      const code=await this.client.getCode({address:p.currency,blockNumber});
      if(!code||code==='0x'||!same(keccak256(code),p.currencyCodeHash))fail('Currency code changed or is absent.',503);
      if(await this.client.readContract({address:p.currency,abi:erc20Abi,functionName:'decimals',blockNumber})!==p.decimals)fail('Currency decimals changed.',503);
    }
    const fields=p.kind==='campaign'?{CURRENCY:p.currency,BENEFICIARY:p.beneficiary,GOAL:p.goal,DEADLINE:p.deadline}:{CURRENCY:p.currency,ATTESTOR:p.attestor,REBATE_BPS:p.rebateBps,BUDGET:p.budget};
    await Promise.all(Object.entries(fields).map(async([functionName,expected])=>{
      const actual=await this.client.readContract({address:p.address,abi:abiFor(p),functionName,blockNumber});
      if(String(actual).toLowerCase()!==String(expected).toLowerCase())fail(`Program immutable ${functionName} differs from the verified manifest.`,503);
    }));
  }
  async details(id,{account}={}) {
    const p=this.entry(id);if(account)account=addr(account);
    const block=await this.client.getBlock();await this.deployment(p,block.number);
    const read=(functionName,args=[])=>this.client.readContract({address:p.address,abi:abiFor(p),functionName,args,blockNumber:block.number});
    const common={...p,verified:true,enabled:this.enabled,account:account??null,blockNumber:block.number,blockHash:block.hash,timestamp:block.timestamp,notes};
    if(p.kind==='campaign'){
      const [totalContributed,totalRefunded,paid,contribution]=await Promise.all([read('totalContributed'),read('totalRefunded'),read('paid'),account?read('contributions',[account]):0n]);
      const phase=paid?'paid':block.timestamp<BigInt(p.deadline)?'open':totalContributed>=BigInt(p.goal)?'successful':'failed';
      return safe({...common,totalContributed,totalRefunded,paid,contribution,phase,refundable:phase==='failed'?contribution:0n});
    }
    const [totalFunded,totalClaimed,claimed]=await Promise.all([read('totalFunded'),read('totalClaimed'),account?read('claimed',[account]):0n]);
    if(totalClaimed>totalFunded||totalFunded>BigInt(p.budget))fail('Invalid cashback contract accounting.',503);
    return safe({...common,totalFunded,totalClaimed,claimed,available:totalFunded-totalClaimed,fundingRemaining:BigInt(p.budget)-totalFunded,
      attestationStatus:this.voucherProvider?'configured':'unconfigured',phase:'cashback'});
  }
  async list({account}={}) {
    if(account)account=addr(account);
    const programs=[],unavailable=[];
    for(const p of this.manifest){try{programs.push(await this.details(p.id,{account}));}catch(e){unavailable.push({id:p.id,reason:e.shortMessage||e.message});}}
    return {status:programs.length?'ready':'undeployed',enabled:this.enabled,programs,unavailable,notes};
  }
  async voucher(body) {
    keys(body,['programId','account']);const account=addr(body.account),p=await this.details(body.programId,{account});
    if(p.kind!=='cashback')fail('This program is not cashback.');
    if(!this.voucherProvider)fail('Cashback attestor is not configured. Import a valid signed voucher or ask the operator to configure verified trade indexing.',503);
    const voucher=await this.voucherProvider({program:p,account});
    const verified=await verifyFeeVoucher(p,voucher,{account,timestamp:p.timestamp});
    return {voucher,accounting:verified.accounting};
  }
  async prepare(body) {
    keys(body,['programId','account','action','amount','voucher']);
    if(!this.enabled)fail('Program transactions are disabled until deployment verification and operator enablement.',503);
    const account=addr(body.account),p=await this.details(body.programId,{account}),action=body.action;
    if(!(p.kind==='campaign'?['contribute','payout','refund']:['fund','claim']).includes(action))fail('Action is not valid for this program.');
    if((!['contribute','fund'].includes(action)&&body.amount!==undefined)||(action!=='claim'&&body.voucher!==undefined))fail('Unexpected action parameters.');
    let amount=0n,args=[],expected,functionName=action,abi=abiFor(p),to=p.address,value=0n,next='send',accounting;
    if(action==='contribute'||action==='fund'){
      if(typeof body.amount!=='string'||!/^\d{1,60}(\.\d{1,36})?$/.test(body.amount)||(body.amount.split('.')[1]?.length??0)>p.decimals)fail('Enter a positive amount within currency precision.');
      amount=parseUnits(body.amount,p.decimals);if(amount<=0n||amount>=2n**256n)fail('Amount is outside supported bounds.');
      if(action==='contribute'&&p.phase!=='open')fail('Contributions close at the campaign deadline.');
      if(action==='fund'&&amount>BigInt(p.fundingRemaining))fail('Funding would exceed the independent cashback budget.');
      args=[amount];expected={event:action==='contribute'?'Contributed':'Funded',args:{[action==='contribute'?'contributor':'funder']:account,amount}};
      if(same(p.currency,zeroAddress))value=amount;
      else {
        const [balance,allowance]=await Promise.all(['balanceOf','allowance'].map(functionName=>this.client.readContract({address:p.currency,abi:erc20Abi,functionName,args:functionName==='balanceOf'?[account]:[account,p.address],blockNumber:BigInt(p.blockNumber)})));
        if(balance<amount)fail('Insufficient program currency balance. Fund the wallet first.');
        if(allowance<amount){const approval=allowance>0n?0n:amount;next=allowance>0n?'reset-approval':'approve';to=p.currency;abi=erc20Abi;functionName='approve';args=[p.address,approval];expected={event:'Approval',args:{owner:account,spender:p.address,value:approval}};}
      }
    }else if(action==='payout'){
      if(p.phase!=='successful')fail('Payout requires a reached goal after the deadline, and can occur only once.');
      expected={event:'Paid',args:{beneficiary:p.beneficiary,amount:p.totalContributed}};
    }else if(action==='refund'){
      if(p.phase!=='failed'||BigInt(p.refundable)===0n)fail('No failed-goal refund is available for this wallet.');
      args=[account];expected={event:'Refunded',args:{contributor:account,amount:p.refundable}};
    }else {
      const verified=await verifyFeeVoucher(p,body.voucher,{account,timestamp:p.timestamp});accounting=verified.accounting;
      const v=body.voucher;
      const digest=await this.client.readContract({address:p.address,abi:CASHBACK_ABI,functionName:'voucherDigest',args:[account,BigInt(v.cumulativeFees),BigInt(v.validUntil),v.evidence]});
      if(!same(digest,verified.digest))fail('Contract voucher domain differs from the reviewed voucher.');
      if(!accounting.claimable)fail(accounting.reason==='nothing-to-claim'?'This voucher has nothing left to claim.':'Voucher exceeds the remaining funded budget; partial claims are not supported.');
      args=[account,BigInt(v.cumulativeFees),BigInt(v.validUntil),v.evidence,v.signature];
      expected={event:'Claimed',args:{trader:account,amount:accounting.due,cumulativeFees:v.cumulativeFees,evidence:v.evidence}};
    }
    const data=encodeFunctionData({abi,functionName,args});
    if(next==='send')await this.client.simulateContract({account,address:to,abi,functionName,args,value});
    else {const result=await this.client.call({account,to,data,value});if(result.data&&result.data!=='0x'&&BigInt(result.data)!==1n)fail('Currency refused approval.');}
    const gas=await this.client.estimateGas({account,to,data,value});
    const timestamp=this.now(),expiresAt=Math.min(timestamp+120000,action==='contribute'?Number(BigInt(p.deadline)*1000n):Infinity,action==='claim'?Number(BigInt(body.voucher.validUntil)*1000n):Infinity);
    if(expiresAt<=timestamp)fail('Preparation expired. Refresh chain state.');
    const record=safe({id:randomUUID(),programId:p.id,action,account,next,status:'prepared',transaction:{from:account,to,data,value:toHex(value),chainId:toHex(p.chainId),gas:toHex(gas*120n/100n)},
      expected,accounting,preparedBlock:p.blockNumber,preparedBlockHash:p.blockHash,createdAt:timestamp,expiresAt,chainId:p.chainId,programCodeHash:p.codeHash,notes});
    this.store.prune?.(timestamp);this.store.save(record);return record;
  }
  async submit(id,txHash) {
    const record=this.store.get(id);if(!record)fail('Program preparation not found.',404);hash(txHash,'Transaction hash');
    if(record.txHash&&!same(record.txHash,txHash))fail('A different transaction is already attached.');
    const tx=await this.client.getTransaction({hash:txHash});const t=record.transaction;
    if(!same(tx.from,t.from)||!same(tx.to,t.to)||!same(tx.input,t.data)||tx.value!==BigInt(t.value)||tx.chainId!==record.chainId)fail('Transaction differs from the prepared wallet, chain, target, calldata or value.');
    if(tx.blockNumber!==null&&tx.blockNumber<=BigInt(record.preparedBlock))fail('Transaction predates this preparation.');
    const prepared=await this.client.getBlock({blockNumber:BigInt(record.preparedBlock)});
    if(!same(prepared.hash,record.preparedBlockHash))fail('Preparation block was reorganized.');
    record.txHash=txHash.toLowerCase();record.status='submitted';this.store.save(record);return this.confirm(record);
  }
  async status(id){const r=this.store.get(id);if(!r)fail('Program preparation not found.',404);return r.txHash?this.confirm(r):r;}
  async confirm(record) {
    let receipt;
    try{receipt=await this.client.getTransactionReceipt({hash:record.txHash});}
    catch(e){if(e.name!=='TransactionReceiptNotFoundError')throw e;record.status='submitted';this.store.save(record);return record;}
    const [block,latest]=await Promise.all([this.client.getBlock({blockNumber:receipt.blockNumber}),this.client.getBlockNumber()]);
    // Final states (including reverted) are written only at canonical depth; a reorg can still include it.
    if(!same(block.hash,receipt.blockHash)||latest<receipt.blockNumber+2n){record.status='submitted';this.store.save(record);return record;}
    if(receipt.status!=='success'){record.status='reverted';this.store.save(record);return record;}
    const p=this.entry(record.programId);if(!same(p.codeHash,record.programCodeHash))fail('Program manifest changed after preparation.',503);
    await this.deployment(p,receipt.blockNumber);
    if(!same(receipt.transactionHash,record.txHash)||!same(receipt.from,record.account)||!same(receipt.to,record.transaction.to)||receipt.blockNumber<=BigInt(record.preparedBlock))fail('Receipt does not match this preparation.');
    const events=receipt.logs.filter(l=>same(l.address,record.transaction.to)).flatMap(log=>{try{return [decodeEventLog({abi:record.next==='send'?abiFor(p):erc20Abi,data:log.data,topics:log.topics,strict:true})];}catch{return [];}}).filter(e=>e.eventName===record.expected.event);
    if(events.length!==1||Object.entries(record.expected.args).some(([key,value])=>String(events[0].args[key]).toLowerCase()!==String(value).toLowerCase()))fail('Receipt event does not match the prepared payment.');
    record.status='confirmed';record.blockNumber=receipt.blockNumber.toString();record.blockHash=receipt.blockHash;this.store.save(record);return record;
  }
  async reconcile(){for(const r of this.store.list('submitted'))try{await this.confirm(r);}catch{console.error('Program reconciliation failed; transaction remains pending verification.');}}
  close(){this.store.close();}
}
