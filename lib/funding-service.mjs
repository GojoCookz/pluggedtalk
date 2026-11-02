import { parseAbi,decodeFunctionData,toHex } from '../../app/node_modules/viem/_esm/index.js';
import { checkedRoute,routeInput } from './market-services.mjs';
import { publicClient } from './launch-service.mjs';

// Official deployment: https://github.com/lifinance/contracts/blob/main/deployments/robinhood.json
export const FUNDING_DIAMOND='0xb477751b76cf82d00a686a1232f5fcd772414af3';
export const FUNDING_FACET='0xb129ce9c3fcd55726ff314a2764d3937fa496071';
const swap='(address callTo,address approveTo,address sendingAssetId,address receivingAssetId,uint256 fromAmount,bytes callData,bool requiresDeposit)';
export const FUNDING_ABI=parseAbi([
  `function swapTokensMultipleV3NativeToERC20(bytes32 transactionId,string integrator,string referrer,address receiver,uint256 minAmountOut,${swap}[] swaps) payable`,
  `function swapTokensSingleV3NativeToERC20(bytes32 transactionId,string integrator,string referrer,address receiver,uint256 minAmountOut,${swap} swaps) payable`,
]);
const LOUPE_ABI=parseAbi(['function facetAddress(bytes4 selector) view returns (address)']);
export function fundingCalldata(data,input) {
  const preview=checkedRoute(data,input),tx=data.transactionRequest;
  if(tx.to.toLowerCase()!==FUNDING_DIAMOND||tx.from?.toLowerCase()!==input.account)throw new Error('Unexpected funding contract or sender.');
  const decoded=decodeFunctionData({abi:FUNDING_ABI,data:tx.data});
  const [,,referrer,receiver,minimum,swaps]=decoded.args;
  const steps=Array.isArray(swaps)?swaps:[swaps];
  if(receiver.toLowerCase()!==input.account||minimum<BigInt(preview.minimumOutput)||minimum>BigInt(preview.outputAmount)||!steps.length||steps.length>4)throw new Error('Funding calldata changes receiver, output or route bounds.');
  if(referrer!==''&&referrer!=='0x0000000000000000000000000000000000000000')throw new Error('Funding referrals are disabled.');
  if(steps[0].fromAmount!==input.amount||steps.at(-1).receivingAssetId.toLowerCase()!==input.quote.address)throw new Error('Funding calldata changes input or output asset.');
  // Native funding only: no wallet ERC-20 pulls, approvals or unreviewed bridge selectors.
  if(steps.some(s=>s.sendingAssetId!=='0x0000000000000000000000000000000000000000'||s.fromAmount>input.amount))throw new Error('Only native ETH funding routes are supported.');
  return {...preview,transaction:{from:input.account,to:FUNDING_DIAMOND,chainId:'0x1237',value:toHex(input.amount),data:tx.data},executable:true,nextHop:'Reprepare Carbon launch after funding confirms.'};
}
export async function prepareFunding(raw,{client=publicClient(),fetcher=fetch}={}) {
  const input=routeInput(raw);if(input.quote.native)throw new Error('Choose an ERC-20 launch quote.');
  if(await client.getChainId()!==4663)throw new Error('RPC chain mismatch.');
  const query=new URLSearchParams({fromChain:'4663',toChain:'4663',fromToken:'0x0000000000000000000000000000000000000000',toToken:input.quote.address,
    fromAmount:input.amount.toString(),fromAddress:input.account,toAddress:input.account,slippage:String(input.slippageBps/10000),slippageScope:'route'});
  const response=await fetcher(`https://li.quest/v1/quote?${query}`,{signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('No ETH funding route for this pair. Retry or fund the selected quote directly.');
  const result=fundingCalldata(await response.json(),input),tx=result.transaction;
  const facet=await client.readContract({address:FUNDING_DIAMOND,abi:LOUPE_ABI,functionName:'facetAddress',args:[tx.data.slice(0,10)]});
  if(facet.toLowerCase()!==FUNDING_FACET)throw new Error('Funding facet changed; operator must verify the new deployment.');
  const gas=await client.estimateGas({account:input.account,to:tx.to,data:tx.data,value:input.amount});
  tx.gas=toHex(gas*120n/100n);
  return result;
}
