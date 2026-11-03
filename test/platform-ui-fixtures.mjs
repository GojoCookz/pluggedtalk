// Browser-only fixtures. Never imported by the application or sent to an RPC/provider.
export const account='0x1111111111111111111111111111111111111111';
export const otherAccount='0x2222222222222222222222222222222222222222';
export const token='0x3333333333333333333333333333333333333333';
export const quote='0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export const contract='0x4444444444444444444444444444444444444444';
export const hash='0x'+'ab'.repeat(32);
export const cid='bafkreicmvyrqyx76pqosx5fdwk6asqdzcaxis6bynbsithhhyav2ggextm';
export const coin={address:token,name:'BROWSER TEST — simulated coin',symbol:'TEST',quoteSymbol:'USDG',maxWalletBps:300,marketCapUsd:null,volume24hUsd:null,change24h:null,launchedAt:1700000000,dexPair:null};
export const transaction=from=>({from,to:contract,data:'0x12345678',value:'0x0',chainId:'0x1237'});
const inputAsset={address:quote,symbol:'USDG',decimals:6,balance:'100000000'},outputAsset={address:token,symbol:'TEST',decimals:18,balance:'20000000000000000000'};
export const market={chainId:4663,tokens:[coin],sampled:1,observedAt:'2026-10-31T00:00:00Z',blockNumber:123,warnings:[]};
export function tradeReview(from,next='trade',side='buy'){
  return {id:'browser-test-trade',account:from,token,next,side,nativeBalance:'1000000000000000000',amountIn:side==='buy'?'1000000':'1000000000000000000',expectedOutput:next==='approve'?null:side==='buy'?'2000000000000000000':'500000',minimumOutput:side==='buy'?'1900000000000000000':'490000',inputAsset:side==='buy'?inputAsset:outputAsset,outputAsset:side==='buy'?outputAsset:inputAsset,router:contract,slippageBps:50,expiresAt:Date.now()+60000,approvalAmount:'1000000',transaction:transaction(from)};
}
export function positions(from){return {chainId:4663,account:from,blockNumber:123,positions:[{...coin,token,creator:account,decimals:6,holderClaimable:'1000000',holderReceived:'2000000',creatorDeferred:'3000000',pendingQuote:'4000000',pendingToken:'1000000000000000000',actions:{holder:true,creator:true,sweep:true}}],splitters:{status:'unconfigured',deployments:[]},social:{resolverConfigured:false}};}
export function rewardReview(body){return {id:'browser-test-reward',account:body.account,action:body.action,expiresAt:Date.now()+120000,transaction:transaction(body.account),expected:{amount:'1000000',decimals:6,symbol:'USDG',recipient:body.recipient||body.account,creator:account}};}
export function programs(from){
  const base={name:'BROWSER TEST — simulated campaign',kind:'campaign',address:contract,currency:quote,symbol:'USDG',decimals:6,chainId:4663,account:from,enabled:true,localTest:true,totalContributed:'10000000',goal:'20000000',deadline:1900000000,beneficiary:otherAccount,contribution:'1000000',refundable:'1000000'};
  return {status:'ready',programs:[{...base,id:'open',phase:'open'},{...base,id:'failed',phase:'failed'},{...base,id:'successful',phase:'successful'},{...base,id:'cashback',name:'BROWSER TEST — separate cashback',kind:'cashback',phase:'cashback',rebateBps:5000,budget:'100000000',totalFunded:'50000000',available:'40000000',claimed:'1000000',fundingRemaining:'50000000',attestor:otherAccount,attestationStatus:'configured'}],unavailable:[],notes:[]};
}
export function programReview(body,next='send'){return {id:'browser-test-program',programId:body.programId,action:body.action,account:body.account,chainId:4663,next,transaction:transaction(body.account),expected:{args:{amount:'1000000',beneficiary:body.action==='payout'?otherAccount:body.account}},expiresAt:Date.now()+60000};}

export async function installMockWallet(page){
  await page.addInitScript(({account,hash})=>{
    const handlers=new Map();
    const wallet=window.testWallet={account,chain:'0x1237',sent:[],reject:false,
      request:async({method,params})=>{
        if(method==='eth_requestAccounts'||method==='eth_accounts')return wallet.account?[wallet.account]:[];
        if(method==='eth_chainId')return wallet.chain;
        if(method==='eth_sendTransaction'){if(wallet.reject)throw Object.assign(new Error('Test wallet rejection'),{code:4001});wallet.sent.push(params[0]);return hash;}
        if(method==='eth_getTransactionReceipt')return {status:'0x1'};
        throw new Error('Unexpected test-wallet method: '+method);
      },on:(event,fn)=>{if(!handlers.has(event))handlers.set(event,new Set());handlers.get(event).add(fn);},
      removeListener:(event,fn)=>handlers.get(event)?.delete(fn),
      emit:(event,value)=>{if(event==='accountsChanged')wallet.account=value[0]??null;if(event==='chainChanged')wallet.chain=value;for(const fn of [...(handlers.get(event)??[])])fn(value);},
    };
    window.ethereum=wallet;
    addEventListener('DOMContentLoaded',()=>{const label=document.createElement('section');label.setAttribute('aria-label','Browser test fixture');label.id='test-fixture-label';label.textContent='BROWSER TEST ONLY — simulated API responses and wallet. No real transactions.';document.body.prepend(label);});
  },{account,hash});
}

export async function mockPlatform(page){
  const state={tradeNext:'approve',programNext:'approve',lastTrade:null,rewardCreator:true,withSplitter:false,mediaAvailable:true,mediaFail:false,mediaDelay:null,launchDelay:null,launchRequests:[],unexpected:[]};
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname,body=route.request().postData()?route.request().postDataJSON():{};
    const send=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    const from=body.account||account;
    if(path==='/api/markets')return send(market);
    if(path==='/api/assets')return send({chainId:4663,assets:[],pools:[],coverage:{issuerAssets:0},indexedAt:market.observedAt});
    if(path==='/api/media/status')return send({available:state.mediaAvailable,acceptedTypes:['image/png'],maxBytes:2097152});
    if(path==='/api/media/pin'){if(state.mediaDelay)await state.mediaDelay;if(state.mediaFail)return send({code:'provider_failure'},502);return send({cid,contentType:'image/png',width:32,height:32,bytes:100});}
    if(path==='/api/trading/balances')return send({account:from,token:{...outputAsset,balance:'20000000000000000000'},quote:{...inputAsset,balance:'100000000'},nativeBalance:'1000000000000000000'});
    if(path==='/api/trading/quote'){state.lastTrade=tradeReview(from,state.tradeNext,body.side);return send(state.lastTrade);}
    if(path==='/api/trading/prepare')return send(state.lastTrade);
    if(path==='/api/trading/submit'||path==='/api/trading/status'){const result={...state.lastTrade,status:'confirmed',actualOutput:state.lastTrade.expectedOutput};state.tradeNext='trade';return send(result);}
    if(path==='/api/rewards/positions'){const data=positions(from);data.positions[0].actions.creator=state.rewardCreator;if(state.withSplitter)data.splitters={status:'configured',deployments:[{status:'verified',address:contract,decimals:6,symbol:'USDG',recipients:[{address:otherAccount,claimable:'1000000'}]}]};return send(data);}
    if(path==='/api/rewards/prepare')return send(rewardReview(body));
    if(path==='/api/rewards/submit')return send({status:'confirmed',txHash:hash});
    if(path==='/api/recipients/resolve')return send({error:'TEST: social provider unconfigured'},503);
    if(path==='/api/programs')return send(programs(new URL(route.request().url()).searchParams.get('account')));
    if(path==='/api/programs/prepare')return send(programReview(body,state.programNext));
    if(path==='/api/programs/submit'){state.programNext='send';return send({status:'confirmed'});}
    if(path==='/api/programs/voucher')return send({voucher:{testOnly:true,signature:'0x1234'}});
    // Undeployed advanced engine and fee vault, matching the real server's unconfigured responses.
    if(path==='/api/advanced/markets')return send({chainId:4663,engine:'plugged-advanced-v1',tokens:[],unavailable:[],truncated:false,available:false,reason:'No advanced deployment profile is configured. Advanced launch is unavailable.'});
    if(path==='/api/advanced/config')return send({available:false,reason:'No advanced deployment profile is configured.'});
    if(path==='/api/vault/status')return send({deployed:false,chainId:4663,address:null,reason:'Fee vault is not deployed or not configured on this server.',windows:{minDays:7,defaultDays:30,maxDays:365}});
    if(path==='/api/launches/prepare'){
      state.launchRequests.push(body);if(state.launchDelay)await state.launchDelay;
      return send({id:'browser-test-launch',input:body,next:'launch',balance:'100000000',allowance:'100000000',fees:{platformVolumeBps:100},opening:{realisedMarketCap:'2500000000'},expiresAt:Date.now()+60000,transaction:transaction(from)});
    }
    state.unexpected.push(path);return send({error:'Unconfigured browser test route: '+path},503);
  });
  return state;
}
