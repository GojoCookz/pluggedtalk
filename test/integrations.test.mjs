import {test,expect} from 'bun:test';
import {usdToQuote,valuation,milestoneProgress} from '../lib/usd.mjs';
import {routeInput,checkedRoute,quoteEthRoute,usdValuation,NATIVE} from '../lib/market-services.mjs';
import {resolveSocial,resolvedRecipient,resolveLaunchRecipients} from '../lib/social-service.mjs';
import {validateRecipients,socialHandle} from '../lib/recipients.mjs';
import {QUOTES} from '../lib/config.mjs';
const wallet='0x1111111111111111111111111111111111111111',other='0x2222222222222222222222222222222222222222';
const usd=QUOTES.find(q=>q.symbol==='USDG'),eth=QUOTES.find(q=>q.native),now=()=>1793490000000;
test('USD conversions preserve $2500 across crypto stock and depegged stablecoin units',()=>{
  expect(usdToQuote('2500','2000',18)).toBe(1250000000000000000n);
  expect(usdToQuote('2500','250',18)).toBe(10000000000000000000n);
  expect(usdToQuote('2500','0.8',6)).toBe(3125000000n);
  expect(usdToQuote('2500','3',6)).toBe(833333334n);
  expect(()=>usdToQuote('2500','0',6)).toThrow();expect(()=>usdToQuote('2500','NaN',6)).toThrow();
  expect(valuation(eth,'2000').openingMarketCapUsd).toBe('2500');
});
test('direct DEX progress is FDV based and bounded, not a reserve migration',()=>{
  expect(milestoneProgress('2500','40000')).toBe(0);expect(milestoneProgress('21250','40000')).toBe(5000);
  expect(milestoneProgress('80000','40000')).toBe(10000);expect(()=>milestoneProgress('2500','2500')).toThrow();
});
test('price lookup rejects wrong chain asset and decimals without stablecoin assumptions',async()=>{
  const token={chainId:4663,address:usd.address,decimals:6,priceUSD:'0.8'};
  const mock=body=>async()=>({ok:true,json:async()=>body});
  const result=await usdValuation(usd.address,'40000',{fetcher:mock(token),now,useCache:false});
  expect(result.openingQuoteRaw).toBe('3125000000');expect(result.priceTimestamp).toBe(null);
  for(const bad of [{...token,chainId:1},{...token,address:wallet},{...token,decimals:18},{...token,priceUSD:'0'}])await expect(usdValuation(usd.address,'40000',{fetcher:mock(bad),now,useCache:false})).rejects.toThrow();
});
const req=()=>routeInput({quote:usd.address,account:wallet,amountEth:'0.01',slippageBps:50});
const response=()=>({action:{fromChainId:4663,toChainId:4663,fromToken:{address:NATIVE},toToken:{address:usd.address,decimals:6},fromAddress:wallet,toAddress:wallet,fromAmount:'10000000000000000'},estimate:{fromAmount:'10000000000000000',toAmount:'20000000',toAmountMin:'19900000'},transactionRequest:{chainId:4663,to:other,value:'0x2386f26fc10000',data:'0x12345678'},tool:'test-provider'});
test('ETH route rejects redirect chain value and slippage substitution',()=>{
  const good=checkedRoute(response(),req(),now());expect(good.minimumOutput).toBe('19900000');expect(good.executable).toBe(false);expect(good.transactionRequest).toBeUndefined();
  for(const mutate of [r=>r.action.toAddress=other,r=>r.action.fromChainId=1,r=>r.action.toToken.address=other,r=>r.transactionRequest.value='0x01',r=>r.estimate.toAmountMin='10000000']){const bad=response();mutate(bad);expect(()=>checkedRoute(bad,req())).toThrow();}
  expect(()=>routeInput({quote:usd.address,account:wallet,amountEth:'0.0000000000000000001'})).toThrow();
});
test('native ETH does not wrap the Robinhood bridged WETH token',async()=>{
  const result=await quoteEthRoute({quote:NATIVE,account:wallet,amountEth:'1'},{fetcher:()=>{throw new Error('Must not fetch a wrapping route');}});
  expect(result.path).toEqual([NATIVE]);expect(result.outputAmount).toBe('1000000000000000000');
});
test('social handles accept profiles not repos spoof domains or duplicate case variants',()=>{
  expect(socialHandle('x','https://x.com/Creator')).toBe('creator');expect(socialHandle('github','@Octocat')).toBe('octocat');
  for(const bad of ['https://github.com/org/repo','https://github.com.evil.test/user','https://x.com/user?owner=1'])expect(()=>socialHandle('github',bad)).toThrow();
  expect(validateRecipients([{kind:'github',username:'Octocat',bps:5000},{kind:'github',username:'octocat',bps:5000}],true).errors.length).toBeGreaterThan(0);
});
test('EVM resolver is server authenticated and signs identity-bound expiring receipts',async()=>{
  let requested;
  const options={apiKey:'test-only-key',secret:'test-only-secret',now,fetcher:async(url,init)=>{requested={url,init};return {ok:true,json:async()=>({success:true,response:{provider:'github',chain:'EVM',wallet,platformData:{id:'fixture-provider-id',username:'octocat'}}})};}};
  const result=await resolveSocial({kind:'github',username:'https://github.com/Octocat'},options);
  expect(requested.url).toContain('chain=EVM');expect(requested.init.headers['x-api-key']).toBe('test-only-key');
  const row={kind:'github',username:'octocat',bps:10000,resolution:result};
  expect(resolvedRecipient(row,options)).toBe(wallet);
  expect(()=>resolvedRecipient({...row,username:'another'},options)).toThrow();
  expect(()=>resolvedRecipient({...row,resolution:{...result,wallet:other}},options)).toThrow();
  expect(()=>resolvedRecipient({...row,resolution:{...result,receipt:result.receipt+'x'}},options)).toThrow();
  expect(()=>resolvedRecipient(row,{...options,now:()=>now()+86400001})).toThrow();
  expect(()=>resolveLaunchRecipients({recipients:[row,{kind:'wallet',address:wallet,bps:1}]},options)).toThrow();
});
test('unconfigured unresolved and non-EVM identities cannot become payout recipients',async()=>{
  await expect(resolveSocial({kind:'x',username:'fixture'},{apiKey:''})).rejects.toThrow('not configured');
  expect(()=>resolvedRecipient({kind:'x',username:'fixture',resolution:{wallet}})).toThrow();
  await expect(resolveSocial({kind:'x',username:'fixture'},{apiKey:'test',fetcher:async()=>({ok:true,json:async()=>({success:true,response:{provider:'twitter',chain:'SOL',wallet,platformData:{id:'1',username:'fixture'}}})})})).rejects.toThrow();
});
