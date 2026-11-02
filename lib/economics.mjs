import { OPENING_USD, DEFAULT_MILESTONE_USD, usdAmount } from './usd.mjs';

const BPS = 10000n;
const positive = (n, name) => { if(typeof n!=='bigint'||n<=0n)throw new Error(`${name} must be positive base units.`); };
export function amountOut(amount, reserveIn, reserveOut) {
  if(typeof amount!=='bigint'||amount<0n)throw new Error('Negative input.');
  positive(reserveIn,'Input reserve');positive(reserveOut,'Output reserve');
  return amount*reserveOut/(reserveIn+amount);
}
export function amountIn(output, reserveIn, reserveOut) {
  positive(output,'Output');positive(reserveIn,'Input reserve');positive(reserveOut,'Output reserve');
  if(output>=reserveOut)throw new Error('Insufficient reserves.');
  return output*reserveIn/(reserveOut-output)+1n; // Pons docs: unconditional +1, not ceilDiv.
}
export function initialCurve(supply, phantom, threshold) {
  positive(supply,'Supply');positive(phantom,'Phantom');positive(threshold,'Threshold');
  const reserved=supply*phantom/(phantom+threshold);
  return {tokenReserve:supply,quoteReserve:phantom,sellable:supply-reserved,reserved,
    openingFdv:phantom,terminalCurveFdv:(phantom+threshold)**2n/phantom};
}
function feeRates(baseBps, creatorBps, openingBps) {
  if([baseBps,creatorBps,openingBps].some(n=>!Number.isInteger(n)||n<0)||baseBps+creatorBps>9900||openingBps>10000)throw new Error('Invalid fees.');
  return [BigInt(baseBps),BigInt(creatorBps),BigInt(Math.min(openingBps,10000-baseBps-creatorBps-100))];
}
export function quoteCurveBuy({gross,quoteReserve,tokenReserve,sellable,baseBps=100,creatorBps=0,openingBps=0}) {
  positive(gross,'Gross input');positive(sellable,'Sellable supply');
  const [base,creator,opening]=feeRates(baseBps,creatorBps,openingBps);
  const fees=amount=>({baseFee:amount*base/BPS,creatorTax:amount*creator/BPS,openingTax:amount*opening/BPS});
  const initial=fees(gross);const net=gross-initial.baseFee-initial.creatorTax-initial.openingTax;
  let output=amountOut(net,quoteReserve,tokenReserve),spent=gross;
  if(output>sellable){output=sellable;const need=amountIn(output,quoteReserve,tokenReserve);const keep=BPS-base-creator-opening;
    spent=(need*BPS+keep-1n)/keep;if(spent>gross)spent=gross;}
  return {output,spent,refund:gross-spent,...fees(spent),appliedOpeningBps:Number(opening),referenceOnly:true};
}
export function quoteCurveSell({tokensIn,tokenReserve,quoteReserve,realQuoteReserve,readyToGraduate=false,baseBps=100,creatorBps=0}) {
  if(readyToGraduate)throw new Error('Curve is ready to graduate; sells are closed.');
  feeRates(baseBps,creatorBps,0);positive(tokensIn,'Token input');
  const gross=amountOut(tokensIn,tokenReserve,quoteReserve);
  if(gross>realQuoteReserve)throw new Error('Insufficient real quote reserves.');
  const baseFee=gross*BigInt(baseBps)/BPS,creatorTax=gross*BigInt(creatorBps)/BPS;
  return {gross,baseFee,creatorTax,output:gross-baseFee-creatorTax,referenceOnly:true};
}
export function feeWaterfall(gross,creatorBps=0,communityBps=0) {
  if(typeof gross!=='bigint'||gross<0n||![creatorBps,communityBps].every(Number.isInteger)||creatorBps<0||creatorBps>1000||communityBps<0||communityBps>10000)throw new Error('Invalid fee allocation.');
  const base=gross*100n/BPS,creatorTax=gross*BigInt(creatorBps)/BPS,platform=base*3000n/BPS;
  const postPlatform=base-platform+creatorTax,community=postPlatform*BigInt(communityBps)/BPS;
  return {base,creatorTax,platform,community,developer:postPlatform-community,total:base+creatorTax};
}

// USD is the product unit. Quote-unit conversion is fetched separately and never changes identity.
export function validateEconomics(raw, quote, quotes) {
  const errors=[];
  if(raw!==undefined&&(!raw||typeof raw!=='object'||Array.isArray(raw)))return {errors:['economics: invalid configuration.']};
  const e=raw??{};
  const openingMarketCapUsd=e.openingMarketCapUsd??OPENING_USD;
  const milestoneMarketCapUsd=e.milestoneMarketCapUsd??DEFAULT_MILESTONE_USD;
  try {
    if(usdAmount(openingMarketCapUsd)!==usdAmount(OPENING_USD))errors.push('Opening market cap is fixed at $2,500 USD.');
    if(usdAmount(milestoneMarketCapUsd)<=usdAmount(OPENING_USD))errors.push('Graduation market-cap target must exceed $2,500 USD.');
  }catch(error){errors.push(error.message);}
  const creatorTaxBps=e.creatorTaxBps??0;
  if(!Number.isInteger(creatorTaxBps)||creatorTaxBps<0||creatorTaxBps>1000)errors.push('creator tax: choose 0–10%.');
  const markets=[];
  if(e.hybridEnabled!==undefined&&typeof e.hybridEnabled!=='boolean')errors.push('hybrid: invalid setting.');
  if(e.hybridEnabled===true){
    if(!Array.isArray(e.markets)||e.markets.length<2||e.markets.length>4)errors.push('hybrid: select 2–4 independent markets.');
    else {
      const seen=new Set();
      for(const row of e.markets){const q=quotes.find(q=>q.address===String(row?.quote??'').toLowerCase());if(!q||seen.has(q.address)){errors.push('hybrid: quote addresses must be supported and distinct.');continue;}seen.add(q.address);
        if(!Number.isInteger(row.allocationBps)||row.allocationBps<=0||row.allocationBps>10000)errors.push('hybrid: supply allocations must be positive whole basis points.');
        markets.push({quote:q.address,allocationBps:row.allocationBps});}
      if(markets.reduce((s,m)=>s+m.allocationBps,0)!==10000)errors.push('hybrid: supply allocations must total 100%.');
      if(markets[0]?.quote!==quote.address)errors.push('hybrid: first market must use the primary quote.');
    }
  }
  return {errors,value:{mechanism:'direct-v4',openingMarketCapUsd:OPENING_USD,milestoneMarketCapUsd,
    progressMetric:'fully-diluted-market-cap-usd',migrationRequired:false,inputCurrency:'ETH',inputChainId:4663,
    creatorTaxBps,baseFeeBps:100,protocolShareBps:3000,platformVolumeBps:30,
    buyFeeBps:100+creatorTaxBps,sellFeeBps:100+creatorTaxBps,
    hybridEnabled:e.hybridEnabled===true,markets}};
}
