import {test,expect} from 'bun:test';
import {amountOut,amountIn,initialCurve,quoteCurveBuy,quoteCurveSell,feeWaterfall,validateEconomics} from '../lib/economics.mjs';
import {validatePlan} from '../lib/plan.mjs';
import {QUOTES} from '../lib/config.mjs';
const eth=QUOTES.find(q=>q.native),usd=QUOTES.find(q=>q.symbol==='USDG');
const base=()=>({name:'Math fixture',symbol:'MATH',description:'',website:'',github:'',chainId:4663,maxWalletBps:300,quote:eth.address,holderBps:10000,recipients:[],rewards:{developerEnabled:false,communityEnabled:true}});
const hybrid=()=>({mechanism:'direct-v4',hybridEnabled:true,openingMarketCapUsd:'2500',milestoneMarketCapUsd:'40000',markets:[{quote:eth.address,allocationBps:5000},{quote:usd.address,allocationBps:5000}]});
test('constant product uses floor output and unconditional inverse increment',()=>{
  expect(amountOut(10n,100n,1000n)).toBe(90n);expect(amountIn(500n,100n,1000n)).toBe(101n);
  expect(()=>amountIn(1000n,100n,1000n)).toThrow();
});
test('native initial reserves match observed Pons curve and distinct FDVs',()=>{
  const c=initialCurve(10n**27n,168n*10n**16n,42n*10n**17n);
  expect(c.reserved).toBe(285714285714285714285714285n);
  expect(c.sellable).toBe(714285714285714285714285715n);
  expect(c.terminalCurveFdv).toBe(2058n*10n**16n);
});
test('opening buy cap leaves one percent; final buy refunds unused input',()=>{
  const c=initialCurve(10n**27n,168n*10n**16n,42n*10n**17n);
  const opening=quoteCurveBuy({...c,gross:10000n,openingBps:9900});
  expect(opening.appliedOpeningBps).toBe(9800);expect(opening.baseFee+opening.openingTax).toBe(9900n);
  const final=quoteCurveBuy({...c,gross:10n**19n});expect(final.output).toBe(c.sellable);
  expect(final.refund).toBeGreaterThan(0n);expect(final.refund+final.spent).toBe(10n**19n);
  const net=final.spent-final.baseFee-final.creatorTax-final.openingTax;
  expect(amountOut(net,c.quoteReserve,c.tokenReserve)).toBeGreaterThanOrEqual(final.output);
});
test('sell pricing includes phantom but cannot withdraw phantom or sell after readiness',()=>{
  const args={tokensIn:100n,tokenReserve:1000n,quoteReserve:200n,realQuoteReserve:50n};
  expect(quoteCurveSell(args).gross).toBe(18n);
  expect(()=>quoteCurveSell({...args,realQuoteReserve:0n})).toThrow();
  expect(()=>quoteCurveSell({...args,readyToGraduate:true})).toThrow();
});
test('platform gets 30 percent of base fee, not 30 percent of volume',()=>{
  const r=feeWaterfall(1000000n,1000,2500);
  expect(r.platform).toBe(3000n);expect(r.creatorTax).toBe(100000n);
  expect(r.community).toBe(26750n);expect(r.developer).toBe(80250n);
  expect(r.platform+r.community+r.developer).toBe(r.total);
  for(let n=0n;n<1000n;n++) {const f=feeWaterfall(n,333,6667);expect(f.platform+f.community+f.developer).toBe(f.total);}
});
test('universal hybrid rejects duplicates bad allocations and invalid USD targets',()=>{
  const valid=hybrid();expect(validateEconomics(valid,eth,QUOTES).errors).toEqual([]);
  for(const bad of [{...valid,openingMarketCapUsd:'2501'},{...valid,markets:[valid.markets[0],valid.markets[0]]},{...valid,milestoneMarketCapUsd:'2499'},
    {...valid,markets:[valid.markets[0],{...valid.markets[1],allocationBps:4999}]},
    {...valid,milestoneMarketCapUsd:'40000.001'}])expect(validateEconomics(bad,eth,QUOTES).errors.length).toBeGreaterThan(0);
});
test('drafts allow missing amounts but canonicalize numeric spelling and reject malformed economics',()=>{
  expect(validatePlan(base()).ok).toBe(true);
  for(const e of [null,[],false,{openingMarketCapUsd:'1e9'},{creatorTaxBps:1001}])expect(validatePlan({...base(),economics:e}).ok).toBe(false);
  const a=validatePlan({...base(),economics:hybrid()});expect(a.ok).toBe(true);
  const e=hybrid();e.openingMarketCapUsd='02500.00';e.milestoneMarketCapUsd='040000.00';
  expect(validatePlan({...base(),economics:e}).value.antiVamp.key).toBe(a.value.antiVamp.key);
  e.milestoneMarketCapUsd='40000.01';expect(validatePlan({...base(),economics:e}).value.antiVamp.key).not.toBe(a.value.antiVamp.key);
});
test('universal policy replaces legacy quote-unit fields; USD target and creator tax change identity',()=>{
  const direct=validatePlan(base()).value;
  expect(validatePlan({...base(),economics:{openingCap:'1.68',graduationTarget:'4.2'}}).value.antiVamp.key).toBe(direct.antiVamp.key);
  expect(direct.economics.openingMarketCapUsd).toBe('2500');expect(direct.economics.migrationRequired).toBe(false);
  for(const e of [{creatorTaxBps:1},{milestoneMarketCapUsd:'36000'}])expect(validatePlan({...base(),economics:e}).value.antiVamp.key).not.toBe(direct.antiVamp.key);
});
