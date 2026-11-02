// Integration-test fixtures ONLY. Never seed discovery or use these responses in production.
import { encodeAbiParameters,encodeFunctionData,erc20Abi,keccak256,parseAbiParameters } from '../../app/node_modules/viem/_esm/index.js';
import { TRADING_ABI,POOL_KEY } from '../lib/trading-abi.mjs';
import { CARBON_DEFAULT as engine } from '../lib/carbon-abi.mjs';

/** JSON-safe endpoint responses with fresh millisecond timestamps and actual ABI encoding. */
export function tradingFixtures(now=Date.now()){
  const account='0x1111111111111111111111111111111111111111',token='0x2222222222222222222222222222222222222222',quote='0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const id='11111111-1111-4111-8111-111111111111',approvalId='22222222-2222-4222-8222-222222222222',hash='0x'+'ab'.repeat(32),replacementHash='0x'+'12'.repeat(32),blockHash='0x'+'cd'.repeat(32);
  const key={currency0:token,currency1:quote,fee:0,tickSpacing:60,hooks:engine.feeHook},poolId=keccak256(encodeAbiParameters(parseAbiParameters(POOL_KEY),[key]));
  const capabilities={minimumOutput:true,onchainDeadline:false};
  const tokenAsset={address:token,symbol:'TEST',decimals:18,balance:'1000000000000000000000',allowance:'1000000000000000000000'};
  const quoteAsset={address:quote,symbol:'USDG',decimals:6,balance:'10000000',allowance:'1000000'};
  const balances={account,token:tokenAsset,quote:quoteAsset,nativeBalance:'100000000000000000',blockNumber:'100',blockHash,chainId:4663,router:engine.tradeRouter,capabilities};
  const review={id,status:'review',createdAt:now,expiresAt:now+60000,preparedBlock:'100',blockHash,token,account,side:'buy',amount:'1',amountIn:'1000000',slippageBps:50,reviewSeconds:60,key,poolId,zeroForOne:false,router:engine.tradeRouter,chainId:4663,inputAsset:quoteAsset,outputAsset:tokenAsset,nativeBalance:balances.nativeBalance,expectedOutput:'123450000000000000000',minimumOutput:'122832750000000000000',approvalAmount:null,next:'trade',transaction:null,capabilities,notes:['TEST FIXTURE ONLY. Not a live quote.']};
  const tx=(to,data)=>({from:account,to,chainId:'0x1237',value:'0x0',data,gas:'0x1d4c0'});
  const prepared={...review,status:'prepared',simulatedAt:now,simulationBlock:'100',gasEstimate:'100000',gasCostEstimate:'120000000',transaction:tx(engine.tradeRouter,encodeFunctionData({abi:TRADING_ABI,functionName:'swap',args:[key,false,1000000n,122832750000000000000n,account]}))};
  const approvalReview={...review,id:approvalId,inputAsset:{...quoteAsset,allowance:'0'},expectedOutput:null,minimumOutput:null,approvalAmount:'1000000',next:'approve'};
  const approvalPrepared={...prepared,...approvalReview,status:'prepared',transaction:tx(quote,encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[engine.tradeRouter,1000000n]}))};
  const submitted={...prepared,status:'submitted',transaction:null,txHash:hash,nonce:'7'};
  const confirmed={...submitted,status:'confirmed',actualOutput:'123450000000000000000',blockNumber:'101',blockHash};
  return {
    fixtureOnly:true,coin:{address:token,name:'Integration test fixture',symbol:'TEST',quote,quoteSymbol:'USDG',poolId},
    requests:{balances:{token,account},quote:{token,account,side:'buy',amount:'1',slippageBps:50,reviewSeconds:60},prepare:{id,account},submit:{id,txHash:hash},status:{id},replacement:{id,txHash:replacementHash,replaces:hash}},
    balances,quote:review,prepare:prepared,approvalQuote:approvalReview,approvalPrepare:approvalPrepared,
    resetQuote:{...approvalReview,inputAsset:{...quoteAsset,allowance:'1'},approvalAmount:'0'},
    resetPrepare:{...approvalPrepared,inputAsset:{...quoteAsset,allowance:'1'},approvalAmount:'0',transaction:tx(quote,encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[engine.tradeRouter,0n]}))},
    fundingQuote:{...review,inputAsset:{...quoteAsset,balance:'0'},expectedOutput:null,minimumOutput:null,next:'fund'},
    submitted,confirmed,approvalConfirmed:{...approvalPrepared,transaction:null,status:'confirmed',txHash:hash,nonce:'7',blockNumber:'101',blockHash},
    reverted:{...submitted,status:'reverted'},notFound:{...prepared,transaction:null,status:'not_found',txHash:hash},
    replacementPending:{...submitted,txHash:replacementHash,previousHashes:[hash]},
    cancelled:{...submitted,status:'cancelled',txHash:replacementHash,previousHashes:[hash],cancellation:true,blockNumber:'101',blockHash},
    errors:{gas:{code:'TRADING_GAS',error:'Insufficient native ETH for estimated gas. Fund ETH separately, then review again.'},expired:{code:'TRADING_EXPIRED',error:'Review expired. Review again.'},rpc:{code:'TRADING_RPC',error:'RPC unavailable'},replacement:{code:'TRADING_REPLACEMENT',error:'Unverified replacement transaction.'}},
  };
}
if(import.meta.main)console.log(JSON.stringify(tradingFixtures(),null,2));
