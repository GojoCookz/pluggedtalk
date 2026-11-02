import { QUOTES } from '../lib/config.mjs';
import { feeWaterfall } from '../lib/economics.mjs';
import { OPENING_USD, DEFAULT_MILESTONE_USD } from '../lib/usd.mjs';
const choices=(selected,esc)=>QUOTES.map(q=>`<option value="${q.address}" ${selected===q.address?'selected':''}>${esc(q.symbol)} · ${q.address.slice(0,6)}…${q.address.slice(-4)}</option>`).join('');
const valuations=new Map();
export function economicsFields(d,t,esc) {
  const e=d.economics;
  return `<section class="form-section" id="launch-economics"><h2>${t('economicsTitle')}</h2><p>${t('universalLaunchHint')}</p><div class="fields">
    <label class="field">${t('openingUsd')}<input name="openingMarketCapUsd" value="${OPENING_USD}" readonly inputmode="decimal"></label>
    <label class="field">${t('milestoneUsd')}<input name="milestoneMarketCapUsd" inputmode="decimal" value="${esc(e.milestoneMarketCapUsd??DEFAULT_MILESTONE_USD)}" required></label>
    <label class="field">${t('creatorTax')}<input name="creatorTaxPercent" type="number" min="0" max="10" step="0.01" value="${(e.creatorTaxBps??0)/100}"></label>
    </div><p class="receipt-note">${t('milestoneMeaning')}</p><p class="receipt-note">${t('universalFees')}</p>
    <details class="curve-preview"><summary>${t('quoteConversion')}</summary><p>${t('conversionHint')}</p><div id="usd-valuation" role="status"></div><button type="button" data-refresh-price>${t('refreshPrice')}</button></details>
    <label class="toggle"><input name="hybridEnabled" type="checkbox" ${e.hybridEnabled?'checked':''}>${t('hybridMarkets')}</label><p class="receipt-note">${t('universalHybridHint')}</p>
    ${e.hybridEnabled?`<div class="hybrid-markets">${(e.markets??[]).map((m,i)=>`<fieldset class="hybrid-row"><legend>${t('market')} ${i+1}</legend><div class="fields"><label class="field full">${t('quote')}<select name="marketQuote" ${i===0?'disabled':''}>${choices(m.quote,esc)}</select></label><label class="field">${t('supplyAllocation')}<input name="marketAllocation" type="number" min="0.01" max="100" step="0.01" value="${m.allocationBps/100}"></label></div>${i>1?`<button type="button" data-remove-market="${i}">${t('removeMarket')}</button>`:''}</fieldset>`).join('')}</div><button type="button" data-add-market ${(e.markets??[]).length>=4?'disabled':''}>${t('addMarket')}</button>`:''}
    <details class="curve-preview"><summary>${t('ethRouteTitle')}</summary><p>${t('ethRouteHint')}</p><label class="field">${t('ethInput')}<input name="routeAmountEth" inputmode="decimal" value="${esc(e.routeAmountEth??'0.01')}" autocomplete="off"></label><button type="button" data-eth-route>${t('previewEthRoute')}</button><p id="eth-route-status" role="status" class="receipt-note"></p></details>
    <details class="curve-preview"><summary>${t('feeExample')}</summary><p id="fee-example" class="receipt-note"></p></details></section>`;
}
export function captureEconomics(form,fields,d,toBps) {
  d.economics??={};const e=d.economics;
  e.mechanism='direct-v4';e.openingMarketCapUsd=OPENING_USD;e.milestoneMarketCapUsd=String(fields.get('milestoneMarketCapUsd')??DEFAULT_MILESTONE_USD);
  e.creatorTaxBps=toBps(String(fields.get('creatorTaxPercent')??'0'));e.routeAmountEth=String(fields.get('routeAmountEth')??'0.01');
  e.hybridEnabled=fields.has('hybridEnabled');
  if(e.hybridEnabled)e.markets=[...form.querySelectorAll('.hybrid-row')].map((row,i)=>({quote:i===0?d.quote:row.querySelector('[name=marketQuote]').value,allocationBps:toBps(row.querySelector('[name=marketAllocation]').value)}));
}
export function curvePreview(d,t,esc) {
  const output=document.querySelector('#fee-example');if(!output)return;
  try{
    const fees=feeWaterfall(100000n,d.economics.creatorTaxBps,d.holderBps);
    output.textContent=`${t('feeExampleBasis')} ${t('platformFee')}: $${(Number(fees.platform)/100).toFixed(2)}; ${t('developerRewards')}: $${(Number(fees.developer)/100).toFixed(2)}; ${t('communityRewards')}: $${(Number(fees.community)/100).toFixed(2)}.`;
  }catch{output.textContent=t('previewNeedsAmounts');}
}
export async function updateValuation(d,t,esc,refresh=false) {
  const target=document.querySelector('#usd-valuation');if(!target)return;
  const quote=d.quote,milestone=d.economics.milestoneMarketCapUsd??DEFAULT_MILESTONE_USD,key=`${quote}:${milestone}`;
  const requestId={};target.requestId=requestId;
  const current=()=>target.isConnected&&target.requestId===requestId&&document.querySelector('[name=quote]')?.value===quote&&document.querySelector('[name=milestoneMarketCapUsd]')?.value===milestone;
  const cached=valuations.get(key);target.textContent=t('loading');
  try{
    let data=cached&&Date.parse(cached.expiresAt)>Date.now()&&!refresh?cached:null;
    if(!data){const response=await fetch(`/api/valuation?${new URLSearchParams({quote,milestoneUsd:milestone})}`,{signal:AbortSignal.timeout(18000)});if(!response.ok)throw new Error();data=await response.json();valuations.set(key,data);}
    if(!current())return;
    if(data.quote!==quote)throw new Error();
    target.innerHTML=`<p class="receipt-note">1 ${esc(data.symbol)} ≈ $${esc(data.priceUsd)}. ${t('openingUsd')}: $2,500 ≈ ${esc(data.openingQuoteUnits)} ${esc(data.symbol)}.</p><p class="receipt-note">${t('priceFetched')}: ${esc(new Date(data.fetchedAt).toLocaleString())}. ${t('indicativePrice')}</p>`;
  }catch{if(current())target.textContent=t('priceUnavailable');}
}
