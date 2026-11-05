import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { NETWORK } from '../lib/config.mjs';
import { translate } from './i18n.js';

// Operate mode. Inherit Plugged's native system type and white/green tokens.
// The receipt separates unswept pool funds from personal claims and fixed destinations.
export function rewardsScreen({wallet,connect,language,esc}){
  const L=(key,args)=>translate(language(),key,args);
  const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
  let root=null,epoch=0,busy=false,data=null,review=null,message='',error='',social=null,provider=null,socialDraft={kind:'github',username:''};
  const requests=new Set();
  const storageKey=account=>`plugged.rewards.pending.${account?.toLowerCase()}`;
  function saved(account=wallet().account){try{return JSON.parse(localStorage.getItem(storageKey(account))||'null');}catch{return null;}}
  function persist(value,account){localStorage.setItem(storageKey(account),JSON.stringify(value));}
  const amount=(n,decimals,symbol)=>{const [whole,fraction]=formatUnits(BigInt(n),decimals).split('.'),formatter=new Intl.NumberFormat(language()),point=formatter.formatToParts(1.1).find(p=>p.type==='decimal').value;return `${formatter.format(BigInt(whole))}${fraction?point+fraction:''} ${symbol}`;};
  const line=(label,value)=>`<div class="receipt-line"><span>${label}</span><strong>${esc(String(value))}</strong></div>`;
  const btn=(action,label,attrs='')=>`<button type="button" data-reward="${action}" ${busy?'disabled':''} ${attrs}>${label}</button>`;
  const actionLabel=a=>({sweep:L('advancedMarkets.sweepPoolFees'),holder:L('rewards.claimHolderRewards'),creator:L('rewards.sweepCreatorFees'),splitter:L('rewards.payFixedRecipient')}[a]);
  const isSweep=a=>['sweep','creator'].includes(a);
  function watch(){
    // Parent invalidates every screen, including inactive routes. An inactive screen
    // must not subscribe again after destroy(); mount is the subscription boundary.
    const next=root?wallet().provider:null;if(provider===next)return;
    provider?.removeListener?.('accountsChanged',invalidate);provider?.removeListener?.('chainChanged',invalidate);provider=next;
    provider?.on?.('accountsChanged',invalidate);provider?.on?.('chainChanged',invalidate);
  }
  function invalidate(){epoch++;data=null;review=null;social=null;message=wallet().account?L('rewards.walletSettingsChangedRefresh'):'';error='';watch();render();if(root&&wallet().account)void run('refresh');}
  async function api(path,body){
    const controller=new AbortController();requests.add(controller);const timeout=setTimeout(()=>controller.abort(),60000);
    try{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});const result=await r.json();if(!r.ok)throw new Error(result.error||L('feeVault.requestFailedRetry'));return result;}
    finally{clearTimeout(timeout);requests.delete(controller);}
  }
  async function bound(account,revision){
    const w=wallet();if(!root||epoch!==revision||!w.provider||!same(w.account,account))throw new Error(L('advancedLaunch.walletChangedReviewAgain'));
    const [chain,accounts]=await Promise.all([w.provider.request({method:'eth_chainId'}),w.provider.request({method:'eth_accounts'})]);
    if(Number(chain)!==4663)throw new Error(L('rewards.switchWalletRobinhoodChain'));
    if(epoch!==revision||wallet().provider!==w.provider||!same(wallet().account,account)||!same(accounts?.[0],account))throw new Error(L('advancedLaunch.walletChangedReviewAgain'));
    return w.provider;
  }
  function render(){
    if(!root)return;const account=wallet().account,pending=saved(account),current=data&&same(data.account,account)?data:null;
    root.innerHTML=`<div id="rewards-screen">
      <div class="page-top"><div><h1>${L('rewards.rewards')}</h1><p>${L('rewards.feesGoTheirConfigured')}</p></div></div>
      <div class="form-actions">${btn(account?'refresh':'connect',account?L('rewards.refreshBalances'):L('rewards.connectWallet'),'class="primary"')}</div>
      ${account?`<p class="address-block"><span class="sr-only">${L('rewards.connectedWallet')}: </span>${esc(account)}</p>`:`<p class="receipt-note">${L('rewards.connectWalletSeeWhat')}</p>`}
      <p id="rewards-status" role="status" aria-live="polite" class="${error?'error-list':'receipt-note'}">${esc(error||message)}</p>
      <div class="form-layout"><div id="reward-positions"></div><section class="plan-receipt rail-panel" aria-label="${L('rewards.rewardReview')}" id="reward-review"></section></div>
      <section class="form-section"><h2>${L('rewards.socialBeneficiaries')}</h2><p class="receipt-note">${L('rewards.resolveXGithubProfile')}</p>
      <form id="rewards-social"><div class="fields"><label class="field">${L('rewards.provider')}<select name="kind" ${busy?'disabled':''}><option value="github" ${socialDraft.kind==='github'?'selected':''}>GitHub</option><option value="x" ${socialDraft.kind==='x'?'selected':''}>X</option></select></label><label class="field">${L('rewards.profileUsername')}<input name="username" required maxlength="100" autocomplete="off" spellcheck="false" placeholder="@username…" value="${esc(socialDraft.username)}" ${busy?'disabled':''}></label></div><button type="submit" ${busy?'disabled':''}>${L('rewards.resolvePayoutAddress')}</button></form>
      <div id="reward-social-result"></div><p class="receipt-note">${L('rewards.noOauthSocialLogin')}</p>
      <a class="text-link" href="https://docs.bags.fm/api-reference/get-fee-share-wallet" target="_blank" rel="noopener noreferrer">${L('rewards.providerDocumentation')}</a></section></div>`;
    const positions=root.querySelector('#reward-positions');
    if(!current)positions.innerHTML=`<section class="form-section"><h2>${L('rewards.confirmedPluggedLaunches')}</h2><p>${busy?L('rewards.readingChainBalances'):account?L('rewards.chooseRefreshBalancesLoad'):L('rewards.launchesEarningsAppearHere')}</p></section>`;
    else{
      positions.innerHTML=current.positions.length?current.positions.map(p=>{
        if(p.status==='unavailable')return `<section class="form-section"><h2>${esc(p.name)}</h2><p class="error-list">${esc(p.error)}</p></section>`;
        return `<section class="form-section"><h2>${esc(p.name)} · ${esc(p.symbol)}</h2><p class="address-block">${esc(p.token)}</p>${line(L('rewards.holderClaimableNow'),amount(p.holderClaimable,p.decimals,p.quoteSymbol))}${line(L('rewards.holderPaidDateQuote'),amount(p.holderReceived,p.decimals,p.quoteSymbol))}${line(L('rewards.unsweptPoolFees'),amount(p.pendingQuote,p.decimals,p.quoteSymbol))}${line(L('rewards.unsweptSellFeesLaunch'),amount(p.pendingToken,18,p.symbol))}<p class="receipt-note">${L('rewards.poolFeesNotPersonal')}</p>${line(L('rewards.creatorFeeWallet'),p.creator)}<div class="form-actions">${['holder',p.actions.creator?'creator':'sweep'].map(a=>p.actions[a]?btn('prepare',actionLabel(a),`data-action="${a}" data-token="${esc(p.token)}"`):'').join('')}</div>${Object.values(p.actions).some(Boolean)?'':`<p class="receipt-note">${L('rewards.nothingToClaimYet')}</p>`}</section>`;
      }).join(''):`<section class="form-section"><h2>${L('rewards.noPluggedRewardsYet')}</h2><p>${L('rewards.noConfirmedPluggedLaunches')}</p><a class="text-link" href="#create">${L('rewards.createCoin')}</a></section>`;
      if(current.truncated)positions.innerHTML+=`<p class="receipt-note">${L('rewards.showingLatest100Launches')}</p>`;
      positions.innerHTML+=`<section class="form-section"><h2>${L('rewards.fixedRecipientSplits')}</h2>${current.splitters.status==='unconfigured'?`<p>${L('rewards.unconfiguredNoVerifiedPlugged')}</p>`:current.splitters.deployments.map(s=>s.status!=='verified'?`<p class="error-list">${esc(s.error)}</p>`:`<p class="address-block">${esc(s.address)}</p>${s.recipients.map(r=>`<div class="recipient-entry">${line(L('rewards.fixedDestination'),r.address)}${line(L('rewards.claimable'),amount(r.claimable,s.decimals,s.symbol))}<p class="receipt-note">${L('rewards.anyoneCanPayGas')}</p>${BigInt(r.claimable)>0n?btn('prepare',actionLabel('splitter'),`data-action="splitter" data-splitter="${esc(s.address)}" data-recipient="${esc(r.address)}"`):''}</div>`).join('')}`).join('')}</section>`;
      if(!current.social.resolverConfigured)root.querySelector('#reward-social-result').innerHTML=`<p class="error-list">${L('rewards.resolutionBlockedServerBags')}</p>`;
    }
    let receipt=`<h2>${L('rewards.reviewBeforeSigning')}</h2><p class="receipt-note">${L('rewards.chooseAvailableActionNothing')}</p>`;
    if(review){const r=review,e=r.expected;receipt=`<h2>${actionLabel(r.action)}</h2>${line(L('feeVault.signingWallet'),r.account)}${line(L('feeVault.contract'),r.transaction.to)}${line(L('programs.network'),'Robinhood · 4663')}${line(isSweep(r.action)?L('rewards.poolQuoteFeesNot'):L('rewards.observedAmount'),amount(e.amount,e.decimals,e.symbol))}${line(isSweep(r.action)?L('rewards.creatorDestination'):L('rewards.fixedDestination'),isSweep(r.action)?e.creator:e.recipient)}<p class="receipt-note">${L('rewards.simulationPassedBalancesCan')}</p>${btn('sign',L('rewards.signWallet'),'class="primary"')}${btn('cancel',L('rewards.cancelReview'))}`;}
    if(pending){receipt+=`<p class="receipt-note">${L('rewards.savedTransactionNeedsConfirmation')}</p>`;
      if(pending.txHash)receipt+=`<a class="text-link" href="${NETWORK.explorer}/tx/${esc(pending.txHash)}" target="_blank" rel="noopener noreferrer">${esc(pending.txHash)}</a>${btn('confirm',L('advancedLaunch.checkConfirmation'))}`;
      else receipt+=`<label class="field">${L('rewards.sentTransactionHash')}<input name="recoveryHash" maxlength="66" placeholder="0x…" autocomplete="off" spellcheck="false"></label>${btn('recover',L('rewards.recoverSentTransaction'))}<p class="receipt-note">${L('rewards.ifYouRejectedWallet')}</p>${btn('discard',L('rewards.discardUnsignedReview'))}`;
    }
    root.querySelector('#reward-review').innerHTML=receipt;
    if(social){root.querySelector('#reward-social-result').innerHTML=`${line(L('rewards.resolvedWallet'),social.wallet)}<p class="receipt-note">${same(account,social.wallet)?L('rewards.connectedAddressMatchesSigning'):L('rewards.connectedWalletDoesNot')}</p>`;}
  }
  async function run(action,attrs={}){
    if(busy||!root)return;const account=wallet().account,revision=epoch,recovery=root.querySelector('[name=recoveryHash]')?.value;
    const socialForm=root.querySelector('#rewards-social'),socialInput=socialForm?Object.fromEntries(new FormData(socialForm)):null;
    if(action==='cancel'){review=null;render();return;}
    if(action==='discard'){localStorage.removeItem(storageKey(account));render();return;}
    busy=true;error='';message=L('advancedLaunch.checking');render();
    try{
      if(action==='connect'){await connect();watch();if(epoch===revision)message=L('rewards.connectedRefreshBalances');return;}
      if(action==='resolve'){
        social=null;const result=await api('/api/recipients/resolve',socialInput);if(epoch!==revision)return;social=result;message=L('rewards.addressResolvedWalletControl');return;
      }
      if(!account)throw new Error(L('rewards.connectWalletFirst'));
      if(action==='refresh'){
        review=null;await bound(account,revision);const result=await api('/api/rewards/positions',{account,chainId:4663});if(epoch!==revision)return;data=result;message=L('rewards.balancesReadFromChain');
      }else if(action==='prepare'){
        if(saved(account))throw new Error(L('rewards.confirmRecoverSavedTransaction'));
        await bound(account,revision);review=null;
        const result=await api('/api/rewards/prepare',{account,chainId:4663,action:attrs.action,...(attrs.token?{token:attrs.token}:{}),...(attrs.splitter?{splitter:attrs.splitter,recipient:attrs.recipient}:{})});
        await bound(account,revision);review=result;message=L('rewards.reviewDestinationThenSign');
      }else if(action==='sign'){
        const r=review;if(!r||r.expiresAt<=Date.now()||!same(r.account,account)||!same(r.transaction.from,account)||Number(r.transaction.chainId)!==4663||BigInt(r.transaction.value)!==0n)throw new Error(L('rewards.reviewExpiredChangedRefresh'));
        const p=await bound(account,revision);if(Date.now()>=r.expiresAt)throw new Error(L('rewards.reviewExpiredReviewAgain'));
        persist({id:r.id,account},account);const hash=await p.request({method:'eth_sendTransaction',params:[r.transaction]});
        if(!/^0x[0-9a-f]{64}$/i.test(hash??''))throw new Error(L('rewards.walletReturnedNoTransaction'));
        persist({id:r.id,account,txHash:hash},account);if(epoch!==revision)return;review=null;
        await confirm(saved(account),account,revision);
      }else if(action==='confirm'||action==='recover'){
        const pending=saved(account);if(!pending)throw new Error(L('rewards.noSavedTransaction'));
        if(action==='recover'){if(!/^0x[0-9a-f]{64}$/i.test(recovery??''))throw new Error(L('advancedMarkets.pasteCompleteTransactionHash'));pending.txHash=recovery;}
        await confirm(pending,account,revision);
      }
    }catch(e){if(epoch===revision)error=e.code===4001?L('rewards.walletRequestRejectedNo'):e.message;}
    finally{busy=false;if(root){render();if(epoch===revision){const target=root.querySelector(action==='prepare'&&!error?'#reward-review':'#rewards-status');target.tabIndex=-1;target.focus({preventScroll:true});if(action==='prepare'&&!error)target.scrollIntoView({block:'center'});}}}
  }
  async function confirm(pending,account,revision){
    const r=await api('/api/rewards/submit',{preparation:{id:pending.id},txHash:pending.txHash,account,chainId:4663});
    if(['confirmed','reverted','no-op','payment-unverified'].includes(r.status))localStorage.removeItem(storageKey(account));else persist(pending,account);
    if(epoch!==revision)return;
    message=r.status==='confirmed'?L('rewards.paymentVerifiedChainRefresh'):r.status==='reverted'?L('rewards.transactionRevertedNoSuccessful'):L('rewards.pendingCanonicalConfirmationCheck');
    if(r.status==='no-op')message=L('rewards.transactionConfirmedWithoutFee');
    if(r.status==='payment-unverified'){message='';error=L('rewards.configuredPayoutCouldNot');}
    data=null;
  }
  const click=e=>{const b=e.target.closest('[data-reward]');if(b&&root?.contains(b))run(b.dataset.reward,b.dataset);};
  const submit=e=>{if(e.target.id==='rewards-social'){e.preventDefault();run('resolve');}};
  const input=e=>{if(e.target.closest('#rewards-social')){socialDraft=Object.fromEntries(new FormData(root.querySelector('#rewards-social')));social=null;root.querySelector('#reward-social-result').textContent='';}};
  function mount(target=document.querySelector('#main')){destroy();root=target;if(!root)throw new Error('Rewards mount root not found.');root.addEventListener('click',click);root.addEventListener('submit',submit);root.addEventListener('input',input);watch();render();if(wallet().account)void run('refresh');}
  function destroy(){epoch++;for(const c of requests)c.abort();requests.clear();provider?.removeListener?.('accountsChanged',invalidate);provider?.removeListener?.('chainChanged',invalidate);provider=null;root?.removeEventListener('click',click);root?.removeEventListener('submit',submit);root?.removeEventListener('input',input);root=null;data=null;review=null;social=null;}
  return {mount,invalidate,destroy};
}
