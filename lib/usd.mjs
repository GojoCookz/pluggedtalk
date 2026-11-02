import { parseUnits, formatUnits } from '../../app/node_modules/viem/_esm/index.js';

export const OPENING_USD = '2500';
export const DEFAULT_MILESTONE_USD = '40000';
export function usdAmount(value) {
  if(typeof value!=='string'||!/^\d{1,12}(\.\d{1,2})?$/.test(value))throw new Error('Enter a USD amount with at most two decimals.');
  const cents=parseUnits(value,2);if(cents<=0n)throw new Error('USD amount must be positive.');return cents;
}
export function priceWad(value) {
  if(typeof value!=='string'||!/^\d{1,20}(\.\d{1,18})?$/.test(value))throw new Error('USD price unavailable.');
  const price=parseUnits(value,18);if(price<=0n)throw new Error('USD price unavailable.');return price;
}
// Round quote-denominated FDV upward by at most one base unit; never assume a stablecoin peg.
export function usdToQuote(usd,priceUsd,decimals) {
  if(!Number.isInteger(decimals)||decimals<0||decimals>18)throw new Error('Invalid quote decimals.');
  const numerator=usdAmount(usd)*10n**18n*10n**BigInt(decimals),denominator=100n*priceWad(priceUsd);
  return (numerator+denominator-1n)/denominator;
}
export function milestoneProgress(currentUsd,milestoneUsd) {
  const start=usdAmount(OPENING_USD),end=usdAmount(milestoneUsd),current=usdAmount(currentUsd);
  if(end<=start)throw new Error('Graduation target must exceed the opening market cap.');
  return current<=start?0:current>=end?10000:Number((current-start)*10000n/(end-start));
}
export function valuation(quote,priceUsd,milestoneUsd=DEFAULT_MILESTONE_USD) {
  if(usdAmount(milestoneUsd)<=usdAmount(OPENING_USD))throw new Error('Graduation target must exceed $2,500.');
  const opening=usdToQuote(OPENING_USD,priceUsd,quote.decimals),milestone=usdToQuote(milestoneUsd,priceUsd,quote.decimals);
  return {quote:quote.address,decimals:quote.decimals,symbol:quote.symbol,priceUsd,
    openingMarketCapUsd:OPENING_USD,milestoneMarketCapUsd:milestoneUsd,
    openingQuoteRaw:opening.toString(),openingQuoteUnits:formatUnits(opening,quote.decimals),
    milestoneQuoteRaw:milestone.toString(),milestoneQuoteUnits:formatUnits(milestone,quote.decimals),
    progressMetric:'fully-diluted-market-cap-usd',migrationRequired:false,indicative:true};
}
