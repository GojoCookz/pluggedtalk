import { writeFile, mkdir } from 'node:fs/promises';
import { createPublicClient,http,erc20Abi,keccak256,encodeFunctionData } from '../../app/node_modules/viem/_esm/index.js';
import { CARBON_ABI,REGISTRY_ABI,HOOK_ABI,CARBON_DEFAULT as deployment } from '../lib/carbon-abi.mjs';
import { QUOTES,NETWORK } from '../lib/config.mjs';
const client=createPublicClient({transport:http(process.env.PLUGGED_RPC_URL||NETWORK.rpc,{timeout:20000,retryCount:1,batch:{batchSize:40,wait:20}})});
if(await client.getChainId()!==4663)throw new Error('RPC chain mismatch');
let blockNumber=await client.getBlockNumber();
const deploymentBlockNumber=blockNumber;
const read=(address,abi,functionName,args=[])=>client.readContract({address,abi,functionName,args,blockNumber});
const [poolManager,feeHook,pairRegistry,tokenImplementation,owner,platformVolumeBps,maxFeeBps,platformRecipient]=await Promise.all([
  ...['poolManager','feeHook','pairRegistry','tokenImplementation'].map(fn=>read(deployment.launcher,CARBON_ABI,fn)),
  read(deployment.pairRegistry,REGISTRY_ABI,'owner'),read(deployment.feeHook,HOOK_ABI,'PLATFORM_VOLUME_BPS'),
  read(deployment.feeHook,HOOK_ABI,'MAX_FEE_BPS'),read(deployment.feeHook,HOOK_ABI,'platformRecipient'),
]);
for(const [key,address] of Object.entries({poolManager,feeHook,pairRegistry}))if(address.toLowerCase()!==deployment[key])throw new Error(`Deployment mismatch: ${key}`);
const hashes={};for(const [key,address] of Object.entries({...deployment,tokenImplementation}).filter(([k])=>k!=='chainId')){const code=await client.getCode({address,blockNumber});if(!code||code==='0x')throw new Error(`Missing code: ${key}`);hashes[key]={address:address.toLowerCase(),codeHash:keccak256(code),codeBytes:(code.length-2)/2};}
const pairs=[];const quotes=QUOTES.filter(q=>!q.native);
for(let offset=0;offset<quotes.length;offset+=10){
  // The public node prunes historical state quickly. Pin each bounded batch separately.
  blockNumber=await client.getBlockNumber({cacheTime:0});
  const batch=quotes.slice(offset,offset+10);
  const results=await Promise.allSettled(batch.flatMap(q=>[
    read(deployment.pairRegistry,REGISTRY_ABI,'pairConfig',[q.address]),
    read(q.address,erc20Abi,'decimals'),
  ]));
  for(let i=0;i<batch.length;i++){const q=batch[i],approval=results[i*2],decimals=results[i*2+1];
    const approved=approval.status==='fulfilled'?approval.value.approved:null;
    const valid=decimals.status==='fulfilled'&&decimals.value===q.decimals;
    const cachedDecimalsMatch=!approved||approval.value.tokenDecimals===q.decimals;
    pairs.push({address:q.address,symbol:q.symbol,decimals:q.decimals,decimalsVerified:valid,cachedDecimalsMatch,approved,checkedBlock:blockNumber.toString(),
      error:approval.status==='rejected'?(approval.reason.details??approval.reason.shortMessage):decimals.status==='rejected'?(decimals.reason.details??decimals.reason.shortMessage):null,
      setupTransaction:valid&&approved===false?{chainId:4663,from:owner,to:pairRegistry,value:'0x0',data:encodeFunctionData({abi:REGISTRY_ABI,functionName:'approvePairWithoutOracle',args:[q.address,q.decimals]})}:null});
  }
}
const report={checkedAt:new Date().toISOString(),blockNumber:deploymentBlockNumber.toString(),lastPairBlock:blockNumber.toString(),deployment,hashes,owner,platformVolumeBps,maxFeeBps,platformRecipient,
  coverage:{configured:quotes.length,approved:pairs.filter(p=>p.approved&&p.cachedDecimalsMatch).length,pendingApproval:pairs.filter(p=>p.setupTransaction).length,failed:pairs.filter(p=>p.approved===null||!p.decimalsVerified||!p.cachedDecimalsMatch).length},pairs};
await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
await writeFile(new URL('../artifacts/carbon-deployment-check.json',import.meta.url),JSON.stringify(report,null,2));
if(!report.coverage.failed){
  await writeFile(new URL('../data/carbon-pairs.json',import.meta.url),JSON.stringify({checkedAt:report.checkedAt,blockNumber:report.blockNumber,lastPairBlock:report.lastPairBlock,owner,coverage:report.coverage,pairs},null,2)+'\n');
  await writeFile(new URL('../data/carbon-deployment.json',import.meta.url),JSON.stringify({checkedAt:report.checkedAt,blockNumber:report.blockNumber,deployment,hashes,platformVolumeBps,maxFeeBps,platformRecipient},null,2)+'\n');
}
console.log(JSON.stringify({checkedAt:report.checkedAt,blockNumber:report.blockNumber,owner,platformVolumeBps,maxFeeBps,platformRecipient,coverage:report.coverage},null,2));
if(report.coverage.failed)process.exitCode=1;
