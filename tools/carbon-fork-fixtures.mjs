import { writeFile,mkdir,readFile } from 'node:fs/promises';
import { encodeFunctionData,parseUnits,formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { buildCarbonParams,launchInput,publicClient,jsonSafe } from '../lib/launch-service.mjs';
import { CARBON_ABI,CARBON_DEFAULT } from '../lib/carbon-abi.mjs';
import { usdValuation } from '../lib/market-services.mjs';
import { usdToQuote } from '../lib/usd.mjs';
import { openingPoint } from '../lib/carbon-helpers.ts';
import { fundingCalldata } from '../lib/funding-service.mjs';
import { routeInput } from '../lib/market-services.mjs';
const client=publicClient(),report=JSON.parse(await readFile(new URL('../artifacts/carbon-deployment-check.json',import.meta.url),'utf8'));
const result={blockNumber:null,chainId:4663};
for(const [index,symbol] of ['USDG','WETH','cbBTC','AAPL'].entries()){
  const quote=report.pairs.find(q=>q.symbol===symbol&&(q.approved||q.setupTransaction));if(!quote)throw new Error(`Missing fixture pair ${symbol}`);
  const price=await usdValuation(quote.address,'40000',{useCache:false});
  const input=launchInput({account:'0x1111111111111111111111111111111111111111',name:`Plugged fork fixture ${symbol}`,symbol:'FORK',quote:quote.address,
    imageCid:'bafkreicmvyrqyx76pqosx5fdwk6asqdzcaxis6bynbsithhhyav2ggextm',openingBuy:formatUnits(usdToQuote('1',price.priceUsd,quote.decimals),quote.decimals),feeBps:200,creatorBps:7500});
  const params=buildCarbonParams(input,price,`0x${(index+12345678).toString(16).padStart(64,'0')}`);
  const token=await client.readContract({address:CARBON_DEFAULT.launcher,abi:CARBON_ABI,functionName:'predictTokenAddress',args:[params.salt]});
  const point=openingPoint(params.supply,params.openingMarketCap,token.toLowerCase()<quote.address,60);
  result[symbol]={quote:quote.address,token,decimals:quote.decimals,buy:params.devBuyPairAmount,opening:params.openingMarketCap,realised:point.realisedMarketCap,
    setup:quote.setupTransaction?.data??'0x',owner:report.owner,calldata:encodeFunctionData({abi:CARBON_ABI,functionName:'launch',args:[params]})};
}
const fundingInput=routeInput({account:'0x1111111111111111111111111111111111111111',quote:result.USDG.quote,amountEth:'0.001',slippageBps:50});
const query=new URLSearchParams({fromChain:'4663',toChain:'4663',fromToken:'0x0000000000000000000000000000000000000000',toToken:fundingInput.quote.address,
  fromAmount:fundingInput.amount.toString(),fromAddress:fundingInput.account,toAddress:fundingInput.account,slippage:'0.005',slippageScope:'route'});
const response=await fetch('https://li.quest/v1/quote?'+query);if(!response.ok)throw new Error('Funding fixture unavailable');
const raw=await response.json(),funding=fundingCalldata(raw,fundingInput);
result.funding={to:funding.transaction.to,data:funding.transaction.data,value:funding.inputAmountWei,minimum:funding.minimumOutput};
await writeFile(new URL('../artifacts/funding-route-fixture.json',import.meta.url),JSON.stringify(raw,null,2));
result.blockNumber=(await client.getBlockNumber()).toString();
await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
await writeFile(new URL('../artifacts/carbon-fork-fixtures.json',import.meta.url),JSON.stringify(jsonSafe(result),null,2));
console.log(JSON.stringify({blockNumber:result.blockNumber,pairs:Object.keys(result).slice(2),purpose:'Local fork only; no transaction broadcast.'}));
