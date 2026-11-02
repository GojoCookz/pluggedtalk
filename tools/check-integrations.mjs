// Read-only provider checks. This never calls Bags' wallet-creating resolver or sends a transaction.
import { writeFile, mkdir } from 'node:fs/promises';
import { QUOTES } from '../lib/config.mjs';
import { usdValuation, quoteEthRoute } from '../lib/market-services.mjs';
import { integrationReadiness } from '../lib/social-service.mjs';
const results=[];
for(const symbol of ['ETH','USDG','AAPL']){
  const quote=QUOTES.find(q=>q.symbol===symbol&&(symbol!=='ETH'||q.native));
  try{results.push({check:`usd-${symbol}`,result:await usdValuation(quote.address,'40000',{useCache:false})});}
  catch(error){results.push({check:`usd-${symbol}`,error:error.message});}
}
try{results.push({check:'eth-to-usdg',result:await quoteEthRoute({quote:QUOTES.find(q=>q.symbol==='USDG').address,account:'0x1111111111111111111111111111111111111111',amountEth:'0.001',slippageBps:50})});}
catch(error){results.push({check:'eth-to-usdg',error:error.message});}
const report={checkedAt:new Date().toISOString(),mode:'read-only; diagnostic quote address; no funds or signatures',readiness:integrationReadiness(),results};
await mkdir(new URL('../artifacts/',import.meta.url),{recursive:true});
await writeFile(new URL('../artifacts/integration-check.json',import.meta.url),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
if(results.some(r=>r.error))process.exitCode=1;
