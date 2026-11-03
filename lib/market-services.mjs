import { boundedJson, PROVIDER_FETCH } from './fetch-json.mjs';
import { isAddress, parseUnits } from '../../app/node_modules/viem/_esm/index.js';
import { NETWORK, QUOTES } from './config.mjs';
import { valuation, DEFAULT_MILESTONE_USD } from './usd.mjs';
import { checkEthUsd, USDG, WETH } from './onchain-price.mjs';

export const NATIVE='0x0000000000000000000000000000000000000000';
const API='https://li.quest/v1';
const prices=new Map();
function supported(address) {
  const q=QUOTES.find(q=>q.address===String(address).toLowerCase());if(!q)throw new Error('Select a configured quote asset by address.');return q;
}
async function request(url,fetcher) {
  const response=await fetcher(url,{...PROVIDER_FETCH,signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(response.status===404?'No route or price is available for this asset.':'Market provider unavailable. Retry shortly.');
  return boundedJson(response,2000000);
}
const accepted=new Map();
export const MAX_ROUTE_ETH='10';
async function providerToken(quote,fetcher) {
  const source=`${API}/token?chain=${NETWORK.id}&token=${quote.address}`;
  const token=await request(source,fetcher);
  if(token.chainId!==NETWORK.id||token.address?.toLowerCase()!==quote.address||token.decimals!==quote.decimals)throw new Error('Price response does not match the selected asset.');
  return {token,source};
}
export async function usdValuation(address,milestoneUsd=DEFAULT_MILESTONE_USD,{fetcher=fetch,now=Date.now,useCache=true,reference=true,client}={}) {
  const quote=supported(address),cached=prices.get(quote.address);
  let price=cached;
  if(!useCache||!cached||now()-cached.fetchedAt>60000){
    const {token,source}=await providerToken(quote,fetcher);
    valuation(quote,token.priceUSD,milestoneUsd);
    // M2 cross-check: ETH/WETH price against the on-chain ETH/USDG pool, scaled by the provider's USDG price.
    if(reference&&(quote.native||quote.address===WETH)){
      const usdg=QUOTES.find(q=>q.address===USDG);
      const {token:usdgToken}=await providerToken(usdg,fetcher);
      await checkEthUsd({ethPriceUsd:token.priceUSD,usdgPriceUsd:usdgToken.priceUSD},client);
    }
    // M2 bound for every asset, including those without an on-chain reference: refuse sudden moves.
    const last=accepted.get(quote.address),next=Number(token.priceUSD);
    if(last&&now()-last.at<3600000&&(next>last.price*1.5||next<last.price/1.5))throw new Error('Price moved too far from the last accepted value; retry pricing.');
    accepted.set(quote.address,{price:next,at:now()});
    price={priceUsd:token.priceUSD,fetchedAt:now(),source};if(useCache)prices.set(quote.address,price);
  }
  return {...valuation(quote,price.priceUsd,milestoneUsd),source:price.source,fetchedAt:new Date(price.fetchedAt).toISOString(),
    expiresAt:new Date(price.fetchedAt+60000).toISOString(),priceTimestamp:null,
    note:'Provider estimate; retrieval time is not the underlying price timestamp. Reprice and simulate at execution.'};
}
export function routeInput(input) {
  if(!input||typeof input!=='object')throw new Error('Provide a route request.');
  const quote=supported(input.quote);
  if(!isAddress(input.account??'')||input.account.toLowerCase()===NATIVE)throw new Error('Connect a wallet to request its route.');
  if(typeof input.amountEth!=='string'||!/^\d{1,8}(\.\d{1,18})?$/.test(input.amountEth))throw new Error('Enter a positive ETH amount with at most 18 decimals.');
  const amount=parseUnits(input.amountEth,18);if(amount<=0n)throw new Error('Enter a positive ETH amount.');
  if(amount>parseUnits(MAX_ROUTE_ETH,18))throw new Error(`Routes are limited to ${MAX_ROUTE_ETH} ETH per request.`);
  const slippageBps=input.slippageBps??50;
  if(!Number.isInteger(slippageBps)||slippageBps<1||slippageBps>500)throw new Error('Slippage must be 0.01–5%.');
  return {quote,account:input.account.toLowerCase(),amount,slippageBps};
}
export function checkedRoute(data,request,now=Date.now()) {
  const {quote,account,amount,slippageBps}=request,a=data.action,e=data.estimate;
  if(a?.fromChainId!==NETWORK.id||a?.toChainId!==NETWORK.id||a?.fromToken?.address?.toLowerCase()!==NATIVE
    ||a?.toToken?.address?.toLowerCase()!==quote.address||a?.toToken?.decimals!==quote.decimals
    ||a?.fromAddress?.toLowerCase()!==account||a?.toAddress?.toLowerCase()!==account
    ||a?.fromAmount!==amount.toString()||e?.fromAmount!==amount.toString())throw new Error('Route response does not match the requested trade.');
  if(!/^\d+$/.test(e.toAmount??'')||!/^\d+$/.test(e.toAmountMin??'')||BigInt(e.toAmountMin)<=0n||BigInt(e.toAmountMin)>BigInt(e.toAmount))throw new Error('Route has no valid minimum output.');
  const requiredMinimum=(BigInt(e.toAmount)*BigInt(10000-slippageBps)+9999n)/10000n;
  if(BigInt(e.toAmountMin)<requiredMinimum)throw new Error('Route exceeds the requested slippage.');
  const tx=data.transactionRequest;
  if(tx?.chainId!==NETWORK.id||!isAddress(tx.to??'')||!/^0x[\da-f]+$/i.test(tx.value??'')||BigInt(tx.value)!==amount||!/^0x([\da-f]{2})+$/i.test(tx.data??''))throw new Error('Route transaction has invalid chain, value or calldata.');
  // Unsigned calldata is intentionally kept server-side until a deployed Plugged router can
  // enforce end-to-end token output, recipient, deadline and fee policy atomically.
  return {status:'quoted',chainId:NETWORK.id,inputCurrency:'ETH',inputAmountWei:amount.toString(),quote:quote.address,
    outputAmount:e.toAmount,minimumOutput:e.toAmountMin,slippageBps,provider:String(data.tool??'LI.FI'),
    purpose:'quote-asset-funding',atomicLaunchTrade:false,executable:false,
    fetchedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),
    path:[NATIVE,quote.address],nextHop:'Plugged token pool after deployment',source:'https://docs.li.fi/api-reference/get-a-quote-for-a-token-transfer'};
}
export async function quoteEthRoute(input,{fetcher=fetch,now=Date.now}={}) {
  const r=routeInput(input);
  if(r.quote.native)return {status:'native',chainId:NETWORK.id,inputCurrency:'ETH',quote:NATIVE,inputAmountWei:r.amount.toString(),
    outputAmount:r.amount.toString(),minimumOutput:r.amount.toString(),path:[NATIVE],purpose:'native-pool-input',atomicLaunchTrade:false,executable:false};
  const query=new URLSearchParams({fromChain:String(NETWORK.id),toChain:String(NETWORK.id),fromToken:NATIVE,toToken:r.quote.address,
    fromAmount:r.amount.toString(),fromAddress:r.account,toAddress:r.account,slippage:String(r.slippageBps/10000),slippageScope:'route'});
  return checkedRoute(await request(`${API}/quote?${query}`,fetcher),r,now());
}
