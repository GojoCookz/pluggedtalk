import { test, expect } from 'bun:test';
import { validatePlan } from '../lib/plan.mjs';
import { blankPrograms, validatePrograms, httpsUrl } from '../lib/programs.mjs';
import { stockAssets, carbonQuotes, indexedPools } from '../lib/catalog.mjs';
import { QUOTES } from '../lib/config.mjs';
const wallet='0x1111111111111111111111111111111111111111';
const plan=()=>({name:'Community',symbol:'TEST',description:'',github:'',website:'',chainId:4663,maxWalletBps:300,quote:QUOTES[1].address,holderBps:10000,recipients:[],rewards:{developerEnabled:false,communityEnabled:true}});
test('community-only plan needs no developer wallet',()=>expect(validatePlan(plan()).ok).toBe(true));
test('anti-vamp canonicalizes ticker and ignores replaceable social metadata',()=>{
  const first=validatePlan(plan()).value;
  const copy=validatePlan({...plan(),symbol:'test',name:' community ',website:'https://example.org',socials:{x:'https://x.com/copy'}}).value;
  expect(first.antiVamp.key).toBe(copy.antiVamp.key);
  const changed=validatePlan({...plan(),quote:QUOTES[0].address}).value;
  expect(first.antiVamp.key).not.toBe(changed.antiVamp.key);
});
test('Merc permits different names or economics; cosmetic case and spacing do not bypass identity',()=>{
  const first=validatePlan({...plan(),name:'My Community'}).value;
  expect(validatePlan({...plan(),name:' my\t COMMUNITY '}).value.antiVamp.key).toBe(first.antiVamp.key);
  expect(validatePlan({...plan(),name:'Other community'}).value.antiVamp.key).not.toBe(first.antiVamp.key);
  expect(validatePlan({...plan(),name:'My Community',economics:{creatorTaxBps:100}}).value.antiVamp.key).not.toBe(first.antiVamp.key);
});
test('replacing developer payee cannot bypass anti-vamp',()=>{
  const p={...plan(),holderBps:0,rewards:{developerEnabled:true,communityEnabled:false},recipients:[{address:wallet,bps:10000}]};
  const copy={...p,recipients:[{address:'0x2222222222222222222222222222222222222222',bps:10000}]};
  expect(validatePlan(p).value.antiVamp.key).toBe(validatePlan(copy).value.antiVamp.key);
});
test('disabled developer cannot retain revenue; all-off rejected',()=>{
  expect(validatePlan({...plan(),holderBps:2500}).ok).toBe(false);
  expect(validatePlan({...plan(),rewards:{developerEnabled:false,communityEnabled:false}}).ok).toBe(false);
});
test('social origins reject lookalike hosts credentials and javascript',()=>{
  for(const value of ['https://x.com.evil.test/me','https://me:pw@x.com/me','javascript:alert(1)','https://x.com/'])expect(httpsUrl(value,['x.com'])).toBe(false);
  expect(validatePlan({...plan(),socials:{x:'https://x.com/plugged',telegram:'https://t.me/plugged',discord:'https://discord.gg/plugged'}}).ok).toBe(true);
});
const campaign=()=>({...blankPrograms(),fundraising:{enabled:true,beneficiary:wallet,goal:'100.123456',deadline:'2027-01-01T12:00:00.000Z'},refunds:{enabled:true,trigger:'goal-not-met-at-deadline'}});
test('campaign requires exact quote precision and protected refunds',()=>{
  expect(validatePrograms(campaign(),6).errors).toEqual([]);
  expect(validatePrograms({...campaign(),fundraising:{...campaign().fundraising,goal:'0.0000001'}},6).errors.length).toBeGreaterThan(0);
  expect(validatePrograms({...campaign(),refunds:{enabled:false}},6).errors.length).toBeGreaterThan(0);
  expect(validatePrograms({...campaign(),fundraising:{...campaign().fundraising,deadline:'2027-02-30T12:00:00.000Z'}},6).errors.length).toBeGreaterThan(0);
});
test('rebates need separate budget and fee rate capped at 100 percent',()=>{
  const p={...blankPrograms(),cashback:{enabled:true,feeRebateBps:1500,budget:'50'}};
  expect(validatePrograms(p,6).errors).toEqual([]);
  expect(validatePrograms({...p,cashback:{...p.cashback,feeRebateBps:10001}},6).errors.length).toBeGreaterThan(0);
  expect(validatePrograms({...p,cashback:{...p.cashback,budget:'0'}},6).errors.length).toBeGreaterThan(0);
});
test('charity designation cannot invent verified endorsement',()=>{
  const result=validatePrograms({...campaign(),charity:{enabled:true,name:'User supplied organization',website:'https://example.org',verified:true}},6);
  expect(result.errors).toEqual([]);expect(result.value.charity.verified).toBeUndefined();
});
test('stock import is chain-address based and rejects duplicate deployments',()=>{
  const row={tokenSymbol:'REAL',tokenName:'Real',tokenDecimals:18,deployments:[{chainId:1,contractAddress:wallet},{chainId:4663,contractAddress:wallet}]};
  expect(stockAssets({assets:[row]})).toHaveLength(1);
  expect(()=>stockAssets({assets:[row,row]})).toThrow();
});
test('Carbon quote extraction excludes commented pending entries and other chains',()=>{
  const text=`const ROBINHOOD_DEPLOYMENT: Deployment = {\n{ symbol: 'REAL', name: 'Real', address: '${wallet}', decimals: 18 },\n// { symbol: 'PENDING', name: 'Pending', address: '${wallet}', decimals: 18 },\n}\nconst PENDING_DEPLOYMENT`;
  expect(carbonQuotes(text).map(r=>r.symbol)).toEqual(['REAL']);
});
test('pool catalog rejects unrelated chains and spoofed token addresses',()=>{
  const p={chainId:'robinhood',pairAddress:wallet,baseToken:{address:wallet},quoteToken:{address:'0x2222222222222222222222222222222222222222'}};
  expect(indexedPools([p,{...p,chainId:'ethereum'},{...p,baseToken:{address:'javascript:bad'}}],new Set([wallet]))).toHaveLength(1);
});
