import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { NETWORK } from '../lib/config.mjs';
import { serverError, translate } from './i18n.js';

// Advanced (plugged-advanced-v1) Discover cards, token page, per-pool trading and per-quote
// rewards. Strings are inline EN/ES. Everything shown comes from server re-verification.
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const short=a=>`${a.slice(0,6)}…${a.slice(-4)}`;
async function request(path,body){
  const r=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)}:{signal:AbortSignal.timeout(60000)});
  const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||'Request failed.');return data;
}
const units=(raw,decimals,symbol,lang)=>{try{return `${new Intl.NumberFormat(lang,{maximumFractionDigits:6}).format(Number(formatUnits(BigInt(raw),decimals)))} ${symbol}`;}catch{return '—';}};

/** Discover section. Loads independently; baseline listings never wait on it. */
export function advancedDiscover({language,esc,onChange}){
  const L=(key,args)=>translate(language(),key,args);
  let state='idle',data=null;
  async function load(){
    if(state==='loading')return;state='loading';onChange();
    try{data=await request('/api/advanced/markets');if(data.chainId!==NETWORK.id||!Array.isArray(data.tokens))throw new Error();state='ready';}
    catch{state='error';data=null;}
    onChange();
  }
  function markup(query=''){
    if(state==='idle')void load();
    const head=`<div class="source-tabs"><strong>${L('advancedMarkets.advanced')}</strong></div>`;
    if(state==='loading'||state==='idle')return `<section aria-label="${L('advancedMarkets.advancedLaunches')}">${head}<p class="receipt-note">${L('advancedMarkets.verifyingAdvancedLaunchesChain')}</p></section>`;
    if(state==='error')return `<section>${head}<p class="receipt-note">${L('advancedMarkets.advancedMarketSourceUnavailable')}</p><button type="button" data-advanced-refresh>${L('advancedMarkets.retry')}</button></section>`;
    if(!data.available)return `<section>${head}<p class="receipt-note">${/profile is configured/.test(data.reason||'')?L('advancedMarkets.advancedLaunchesNotSet'):esc(serverError(data.reason||L('advancedMarkets.advancedLaunchesUnavailable'),language()))}</p></section>`;
    const q=query.toLowerCase().trim(),rows=data.tokens.filter(c=>`${c.name} ${c.symbol} ${c.address}`.toLowerCase().includes(q));
    const cards=rows.map(c=>`<a class="coin" href="#advanced-token/${esc(c.address)}" aria-label="${esc(`${c.name} ${c.symbol} ${L('advancedMarkets.advanced')}`)}"><div class="coin-head"><div><h2 class="coin-name">${esc(c.name)}</h2><small>${esc(c.symbol)}</small> <span class="coin-addr">${short(c.address)}</span></div></div>
      <div class="coin-stats"><div><small>${L('advancedMarkets.quotePools')}</small><strong>${c.markets.length}</strong></div><div><small>${L('advancedLaunch.walletCap')}</small><strong>3%</strong></div></div>
      <div class="coin-foot"><span>${c.markets.map(m=>esc(m.symbol)).join(' · ')} · ${L('advancedMarkets.advanced')}</span></div></a>`).join('');
    return `<section aria-label="${L('advancedMarkets.advancedLaunches')}">${head}<p class="receipt-note">${L('advancedMarkets.reVerifiedChainAt')} ${esc(String(data.blockNumber))}. ${L('advancedMarkets.noPriceVolumeIndex')}</p>
      ${rows.length?`<div class="coin-grid">${cards}</div>`:`<p class="receipt-note">${L('advancedMarkets.noConfirmedAdvancedLaunches')}</p>`}
      ${data.unavailable.length?`<p class="callout">${data.unavailable.length} ${L('advancedMarkets.advancedLaunchEsFailed')}</p>`:''}
      ${data.truncated?`<p class="receipt-note">${L('advancedMarkets.showingLatest50Advanced')}</p>`:''}</section>`;
  }
  return {markup,load,refresh(){state='idle';void load();}};
}

/** Token page: per-pool market facts plus a pool selector driving the shared trade panel. */
export function advancedTokenScreen({language,esc,trading}){
  const L=(key,args)=>translate(language(),key,args);
  let host=null,epoch=0,token=null,pool=null;
  function panel(){
    const aside=host?.querySelector('#advanced-trading');if(!aside||!token)return;
    const m=token.markets.find(x=>same(x.pool,pool))??token.markets[0];pool=m.pool;
    trading.mount(aside,{address:token.address,symbol:token.symbol,quoteSymbol:m.symbol,pool:m.pool});
  }
  function render(error){
    if(!host)return;
    if(error||!token){host.innerHTML=`<a class="text-link" href="#discover">${L('advancedMarkets.backCoins')}</a><section class="form-section"><h1>${L('advancedMarkets.advancedToken')}</h1><p class="${error?'error-list':'receipt-note'}" role="status">${esc(error?serverError(error,language()):L('advancedMarkets.reVerifyingChain'))}</p>${error?`<p class="receipt-note">${L('advancedMarkets.tradingStaysUnavailableUntil')}</p>`:''}</section>`;return;}
    const lang=language(),rows=token.markets.map(m=>`<tr><td><label><input type="radio" name="advanced-pool" value="${esc(m.pool)}" ${same(m.pool,pool)?'checked':''}> ${esc(m.symbol)}</label></td><td>${units(m.marketCapQuote,m.decimals,m.symbol,lang)}</td><td>${(Number(m.graduationProgressBps)/100).toFixed(2)}%${m.graduated?` · ${L('advancedMarkets.graduated')}`:''}</td><td>${m.feeBps/100}%</td><td><span class="address-block">${esc(short(m.poolId))}</span></td></tr>`).join('');
    host.innerHTML=`<a class="text-link" href="#discover">${L('advancedMarkets.backCoins')}</a><div class="detail-header"><div><h1>${esc(token.name)}</h1><p class="muted">${esc(token.symbol)} · ${L('advancedMarkets.advanced')} · ${token.markets.length} ${L('advancedMarkets.quotePools2')}</p></div></div>
      <div class="layout token-layout"><section class="token-source"><fieldset><legend>${L('advancedMarkets.chooseQuotePoolTrade')}</legend><div class="table-scroll"><table><thead><tr><th>${L('advancedMarkets.pool')}</th><th>${L('advancedMarkets.poolValueHook')}</th><th>${L('advancedMarkets.milestoneProgress')}</th><th>${L('advancedMarkets.fee')}</th><th>${L('advancedMarkets.poolId')}</th></tr></thead><tbody>${rows}</tbody></table></div></fieldset>
      <p class="receipt-note">${L('advancedMarkets.eachPoolHoldsEqual')}</p>
      <p class="receipt-note">${L('advancedMarkets.tokenEnforces3Wallet')}</p>
      <p class="address-block">${esc(token.address)}</p><div class="form-actions"><a class="primary-link" href="${NETWORK.explorer}/token/${esc(token.address)}" target="_blank" rel="noopener noreferrer">${L('advancedMarkets.viewExplorer')}</a></div>
      <p class="receipt-note">${L('advancedMarkets.verifiedAtBlock')} ${esc(String(token.blockNumber))}</p></section><aside id="advanced-trading" aria-label="${L('advancedMarkets.trade')}"></aside></div>`;
    panel();
  }
  function changed(event){if(event.target.name==='advanced-pool'){pool=event.target.value;panel();}}
  async function mount(root,address){
    destroy();host=root;const revision=++epoch;host.addEventListener('change',changed);render();
    try{const result=await request(`/api/advanced/token?address=${encodeURIComponent(address||'')}`);if(revision!==epoch)return;token=result;pool=result.markets[0]?.pool;render();}
    catch(e){if(revision===epoch)render(e.message);}
  }
  function destroy(){epoch++;trading.destroy();if(host){host.removeEventListener('change',changed);host.innerHTML='';}host=null;token=null;pool=null;}
  return {mount,destroy,invalidate(){trading.invalidate();}};
}

/** Earnings: per-quote sweeps, fixed-recipient releases and stuck-fee recovery. */
export function advancedRewardsScreen({wallet,connect,language,esc}){
  const L=(key,args)=>translate(language(),key,args);
  let root=null,epoch=0,busy=false,data=null,message='',error='',hash='';
  const key=a=>`plugged.advancedRewards.pending.${a?.toLowerCase()}`;
  const saved=a=>{try{return JSON.parse(localStorage.getItem(key(a))||'null');}catch{return null;}};
  const label=a=>({sweep:L('advancedMarkets.sweepPoolFees'),release:L('advancedMarkets.releaseMySplit'),'recover-splitter':L('advancedMarkets.recoverStuckCreatorFees'),'recover-feed':L('advancedMarkets.recoverStuckHolderFees')}[a]);
  const btn=(attrs,text)=>`<button type="button" ${attrs} ${busy?'disabled':''}>${text}</button>`;
  function render(){
    if(!root)return;const account=wallet().account,pending=saved(account),lang=language();
    const pools=data?.positions?.map(p=>p.status!=='verified'?`<section class="form-section"><h3>${esc(p.symbol||p.token)}</h3><p class="error-list">${esc(p.error)}</p></section>`:
      `<section class="form-section"><h3>${esc(p.name)} · ${esc(p.symbol)} · ${L('advancedMarkets.advanced')}</h3>${p.pools.map(m=>`<div class="recipient-entry"><strong>${esc(m.symbol)} ${L('advancedMarkets.pool2')}</strong>
        <div class="receipt-line"><span>${L('advancedMarkets.unsweptPoolFees')}</span><strong>${units(m.pendingQuote,m.decimals,m.symbol,lang)}</strong></div>
        <div class="receipt-line"><span>${L('advancedMarkets.stuckCreatorFees')}</span><strong>${units(m.splitterStuck,m.decimals,m.symbol,lang)}</strong></div>
        <div class="receipt-line"><span>${L('advancedMarkets.stuckHolderFees')}</span><strong>${units(m.feedStuck,m.decimals,m.symbol,lang)}</strong></div>
        ${m.account?`<div class="receipt-line"><span>${L('advancedMarkets.splitClaimable')} (${m.account.bps/100}%)</span><strong>${units(m.account.claimable,m.decimals,m.symbol,lang)}</strong></div>`:''}
        <p class="receipt-note">${L('advancedMarkets.holderFeesGoBasket')}</p>
        <div class="form-actions">${Object.entries(m.actions).filter(([,on])=>on).map(([a])=>btn(`data-adv-reward="${a}" data-token="${esc(p.token)}" data-pool="${esc(m.pool)}"`,label(a))).join('')}</div></div>`).join('')}</section>`).join('')??'';
    root.innerHTML=`<section class="form-section" aria-label="${L('advancedMarkets.advancedRewards')}"><h2>${L('advancedMarkets.advancedLaunchRewards')}</h2>
      <div class="form-actions">${account?btn('data-adv-reward="refresh"',L('advancedMarkets.refreshAdvancedRewards')):`<p class="receipt-note">${L('advancedMarkets.connectWalletAboveSee')}</p>`}</div>
      <p role="status" aria-live="polite" class="${error?'error-list':'receipt-note'}">${esc(error||message)}</p>
      ${data&&!data.available?`<p class="receipt-note">${L('advancedMarkets.unavailable')}${esc(data.reason||'')}</p>`:''}
      ${data?.available&&!data.positions.length?`<p class="receipt-note">${L('advancedMarkets.noConfirmedAdvancedLaunches2')}</p>`:''}${pools}
      ${pending?`<div class="callout"><p>${L('advancedMarkets.rewardTransactionPendingCheck')}</p>${pending.txHash?btn('data-adv-reward="check"',L('advancedLaunch.checkConfirmation')):`<label class="field">${L('advancedMarkets.transactionHashFromWallet')}<input data-adv-hash maxlength="66" value="${esc(hash)}" placeholder="0x…" autocomplete="off" spellcheck="false"></label>${btn('data-adv-reward="check"',L('advancedMarkets.recoverTransaction'))}${btn('data-adv-reward="clear"',L('advancedMarkets.walletConfirmsNothingWas'))}`}</div>`:''}</section>`;
  }
  async function bound(account,revision){
    const w=wallet();if(!w.provider||!same(w.account,account)||revision!==epoch)throw new Error(L('advancedLaunch.walletChangedReviewAgain'));
    const [chain,accounts]=await Promise.all([w.provider.request({method:'eth_chainId'}),w.provider.request({method:'eth_accounts'})]);
    if(Number(chain)!==4663)throw new Error(L('advancedMarkets.switchWalletRobinhoodChain'));
    if(!same(accounts?.[0],account)||revision!==epoch)throw new Error(L('advancedLaunch.walletChangedReviewAgain'));
    return w.provider;
  }
  async function run(button){
    const action=button.dataset.advReward;if(busy)return;
    if(action==='connect'){try{await connect();}catch{}return;}
    const account=wallet().account,revision=epoch;if(!account)return;
    busy=true;error='';message=L('advancedLaunch.checking');render();
    try{
      if(action==='refresh'){data=await request('/api/advanced/rewards/positions',{account,chainId:4663});message=L('advancedMarkets.readFromRobinhoodChain');}
      else if(action==='clear'){localStorage.removeItem(key(account));message='';}
      else if(action==='check'){
        const p=saved(account),txHash=p?.txHash||hash.trim();if(!p?.id||!/^0x[0-9a-f]{64}$/i.test(txHash))throw new Error(L('advancedMarkets.pasteCompleteTransactionHash'));
        localStorage.setItem(key(account),JSON.stringify({...p,txHash}));
        const r=await request('/api/advanced/rewards/submit',{preparation:{id:p.id},txHash,account,chainId:4663});
        if(['confirmed','reverted','no-op','payment-deferred'].includes(r.status))localStorage.removeItem(key(account));
        message={confirmed:L('advancedMarkets.confirmedChain'),reverted:L('advancedMarkets.transactionRevertedNothingWas'),'no-op':L('advancedMarkets.noFeesWereLeft'),'payment-deferred':L('advancedMarkets.payoutWasDeferredBy')}[r.status]??L('advancedMarkets.stillPendingConfirmingCheck');
      }else{
        if(saved(account))throw new Error(L('advancedMarkets.resolvePendingTransactionFirst'));
        const prepared=await request('/api/advanced/rewards/prepare',{account,chainId:4663,action,token:button.dataset.token,pool:button.dataset.pool});
        const provider=await bound(account,revision),tx=prepared.transaction;
        if(!same(tx.from,account)||Number(tx.chainId)!==4663||tx.value!=='0x0')throw new Error(L('advancedMarkets.transactionContextChanged'));
        localStorage.setItem(key(account),JSON.stringify({id:prepared.id}));
        let txHash;try{txHash=await provider.request({method:'eth_sendTransaction',params:[tx]});}catch(e){if(e.code===4001)localStorage.removeItem(key(account));throw e;}
        localStorage.setItem(key(account),JSON.stringify({id:prepared.id,txHash}));
        message=L('advancedMarkets.sentCheckConfirmationAfter');
      }
    }catch(e){error=e.code===4001?L('advancedMarkets.walletRequestRejectedNothing'):e.message;}
    finally{busy=false;render();}
  }
  const clicked=e=>{const b=e.target.closest('[data-adv-reward]');if(b&&root?.contains(b))void run(b);};
  const typed=e=>{if(e.target.matches('[data-adv-hash]'))hash=e.target.value;};
  function mount(next){destroy();root=next;root.addEventListener('click',clicked);root.addEventListener('input',typed);render();}
  function destroy(){epoch++;if(root){root.removeEventListener('click',clicked);root.removeEventListener('input',typed);root.innerHTML='';}root=null;data=null;}
  return {mount,destroy,invalidate(){epoch++;data=null;message='';error='';render();}};
}
