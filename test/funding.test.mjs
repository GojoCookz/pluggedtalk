import { test,expect } from 'bun:test';
import { encodeFunctionData,parseUnits } from '../../app/node_modules/viem/_esm/index.js';
import { fundingCalldata,FUNDING_ABI,FUNDING_DIAMOND } from '../lib/funding-service.mjs';
import { routeInput } from '../lib/market-services.mjs';
const account='0x1111111111111111111111111111111111111111',zero='0x0000000000000000000000000000000000000000',quote='0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const input=routeInput({account,quote,amountEth:'0.001',slippageBps:50});
function response({receiver=account,min=995000n,asset=quote,sending=zero,target=FUNDING_DIAMOND}={}){
  return {action:{fromChainId:4663,toChainId:4663,fromToken:{address:zero},toToken:{address:quote,decimals:6},fromAddress:account,toAddress:account,fromAmount:input.amount.toString()},
    estimate:{fromAmount:input.amount.toString(),toAmount:'1000000',toAmountMin:'995000'},
    transactionRequest:{to:target,from:account,chainId:4663,value:'0x'+input.amount.toString(16),data:encodeFunctionData({abi:FUNDING_ABI,functionName:'swapTokensMultipleV3NativeToERC20',args:['0x'+'00'.repeat(32),'lifi-api','',receiver,min,[{callTo:account,approveTo:account,sendingAssetId:sending,receivingAssetId:asset,fromAmount:input.amount,callData:'0x12345678',requiresDeposit:true}]]})}};
}
test('native funding decoder binds minimum output, receiver, asset and trusted diamond',()=>{
  expect(fundingCalldata(response(),input).executable).toBe(true);
  for(const bad of [{receiver:quote},{min:1n},{asset:account},{sending:quote},{target:account}])expect(()=>fundingCalldata(response(bad),input)).toThrow();
});
