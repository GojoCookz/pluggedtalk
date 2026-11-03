import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { serverError, translate } from './i18n.js';

// Reclaimable fee containers. Every amount shown is an on-chain vault read at one block;
// nothing is estimated. Undeployed or unverified vaults render an honest unavailable state.
export function feeVaultScreen({wallet,connect,language,esc}){
  const L=(key,args)=>translate(language(),key,args);
  const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
  let root=null,epoch=0,busy=false,status=null,data=null,review=null,message='',error='',provider=null,extendDays=30;
  const requests=new Set();
  const stateLabel=s=>({pending:L('feeVault.waitingResponse'),accepted:L('feeVault.accepted'),declined:L('feeVault.declined'),reclaimed:L('feeVault.returnedAllocator'),expired:L('feeVault.expired')}[s]??s);
  const actionLabel=a=>({accept:L('feeVault.acceptWallet'),decline:L('feeVault.decline'),claim:L('feeVault.claim'),reclaim:L('feeVault.reclaimMyWallet'),sweep:L('feeVault.collectInboxFunds'),operatorReturn:L('feeVault.returnAllocator'),extend:L('feeVault.extendDeadline')}[a]);
  const amount=(n,decimals,symbol)=>{const [whole,fraction]=formatUnits(BigInt(n),decimals).split('.'),f=new Intl.NumberFormat(language()),point=f.formatToParts(1.1).find(p=>p.type==='decimal').value;return `${f.format(BigInt(whole))}${fraction?point+fraction:''} ${symbol}`;};
  const date=s=>new Intl.DateTimeFormat(language(),{dateStyle:'medium',timeStyle:'short'}).format(new Date(s*1000));
  const line=(label,value)=>`<div class="receipt-line"><span>${label}</span><strong>${esc(String(value))}</strong></div>`;
  const short=a=>a?`${a.slice(0,6)}…${a.slice(-4)}`:'';
  function watch(){const next=root?wallet().provider:null;if(provider===next)return;provider?.removeListener?.('accountsChanged',invalidate);provider?.removeListener?.('chainChanged',invalidate);provider=next;provider?.on?.('accountsChanged',invalidate);provider?.on?.('chainChanged',invalidate);}
  function invalidate(){epoch++;data=null;review=null;message=status?.deployed&&wallet().account?L('feeVault.walletSettingsChangedRefresh'):'';error='';watch();render();}
  async function api(path,body){
    const controller=new AbortController();requests.add(controller);const timeout=setTimeout(()=>controller.abort(),60000);
    try{const r=await fetch(path,body===undefined?{signal:controller.signal}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});const result=await r.json();if(!r.ok)throw new Error(result.error?serverError(result.error,language()):L('feeVault.requestFailedRetry'));return result;}
    finally{clearTimeout(timeout);requests.delete(controller);}
  }
  async function bound(account,revision){
    const w=wallet();if(!root||epoch!==revision||!w.provider||!same(w.account,account))throw new Error(L('advancedLaunch.walletChangedReviewAgain'));
    const [chain,accounts]=await Promise.all([w.provider.request({method:'eth_chainId'}),w.provider.request({method:'eth_accounts'})]);
    if(Number(chain)!==status.chainId)throw new Error(L('feeVault.switchWalletChainThen',{p0:status.chainId}));
    if(epoch!==revision||!same(accounts?.[0],account))throw new Error(L('advancedLaunch.walletChangedReviewAgain'));
    return w.provider;
  }
  function card(c,role){
    const money=n=>amount(n,c.decimals,c.symbol),acts=Object.entries(c.actions).filter(([,ok])=>ok).map(([a])=>a);
    const held=BigInt(c.balance)+BigInt(c.inboxBalance);
    return `<article class="form-section" data-container="${esc(c.id)}"><h3>${L('feeVault.container')} #${esc(c.id)} · ${esc(stateLabel(c.state))}</h3>
      ${line(L('feeVault.heldContainer'),money(held))}
      ${BigInt(c.inboxBalance)>0n?line(L('feeVault.whichStillInbox'),money(c.inboxBalance)):''}
      ${line(L('feeVault.paidOutSoFar'),money(c.paid))}
      ${line(role==='recipient'?L('feeVault.fromAllocator'):L('feeVault.recipientWallet'),short(role==='recipient'?c.allocator:c.recipient))}
      ${c.state==='pending'?line(L('feeVault.respondBefore'),date(c.deadline)):line(L('feeVault.deadline'),date(c.deadline))}
      ${c.operator?line(L('feeVault.operatorDeadlineReturnOnly'),short(c.operator)):''}
      <p class="address-block">${L('feeVault.inbox')}: ${esc(c.inbox)}</p>
      ${role==='recipient'&&c.state==='pending'?`<p class="receipt-note">${L('feeVault.acceptingProvesYouControl')}</p>`:''}
      ${role==='allocator'&&c.state==='pending'?`<p class="receipt-note">${L('feeVault.youCanReclaimOnly')}</p>`:''}
      <div class="actions">${acts.map(a=>`<button type="button" data-vault="${a}" data-id="${esc(c.id)}" ${busy?'disabled':''}>${esc(actionLabel(a))}</button>`).join('')}</div></article>`;
  }
  function render(){
    if(!root)return;const account=wallet().account;let body;
    if(!status)body=`<p>${L('feeVault.checkingFeeVault')}</p>`;
    else if(!status.deployed)body=`<p>${L('feeVault.notDeployedYetNo')}</p>`;
    else if(!account)body=`<p>${L('feeVault.afterYouConnectWallet')}</p>`;
    else{
      const current=data&&same(data.account,account)?data:null;
      body=`<p class="address-block">${L('feeVault.vault')}: ${esc(status.address)}</p><button type="button" data-vault="refresh" ${busy?'disabled':''}>${current?L('feeVault.refreshContainers'):L('feeVault.loadContainers')}</button>`;
      if(current){
        body+=`<h3>${L('feeVault.addressedYou')}</h3>${current.recipient.length?current.recipient.map(c=>card(c,'recipient')).join(''):`<p>${L('feeVault.noContainersWallet')}</p>`}`;
        body+=`<h3>${L('feeVault.createdByYou')}</h3>${current.allocator.length?current.allocator.map(c=>card(c,'allocator')).join(''):`<p>${L('feeVault.youHaveNotAllocated')}</p>`}`;
        body+=`<p class="receipt-note">${L('feeVault.amountsReadAtBlock')} ${esc(current.blockNumber)}.</p>`;
      }
    }
    let receipt='';
    if(review){const e=review.expected;receipt=`<section class="form-section"><h3>${esc(actionLabel(review.action))} · #${esc(review.containerId)}</h3>${line(L('feeVault.signingWallet'),review.account)}${line(L('feeVault.contract'),review.transaction.to)}
      ${BigInt(e.amount)>0n?line(L('feeVault.amount'),amount(e.amount,e.decimals,e.symbol)):''}${e.payee?line(L('feeVault.paidOnly'),e.payee):''}
      ${review.notes.map(n=>`<p class="receipt-note">${esc(serverError(n,language()))}</p>`).join('')}
      <div class="actions"><button type="button" data-vault="sign" ${busy?'disabled':''}>${L('feeVault.signWallet')}</button><button type="button" data-vault="cancel" ${busy?'disabled':''}>${L('feeVault.cancel')}</button></div></section>`;}
    const extend=data&&account?`<label class="receipt-note">${L('feeVault.extendByDaysMax')} <input type="number" min="1" max="365" inputmode="numeric" data-vault-days value="${extendDays}"></label>`:'';
    root.innerHTML=`<section class="form-section" aria-labelledby="fee-vault-title"><h2 id="fee-vault-title">${L('feeVault.reclaimableFeeContainers')}</h2>
      <p>${L('feeVault.feesInvitedRecipientWait')}</p>
      ${body}${extend}${receipt}
      <p role="status" aria-live="polite">${esc(message)}</p>${error?`<p role="alert" class="error-list">${esc(error)}</p>`:''}</section>`;
  }
  // Re-rendering replaces the buttons; return focus to the same control, else to the outcome text.
  async function run(task,focusKey){if(busy)return;busy=true;error='';render();try{await task();}catch(e){if(e?.name!=='AbortError')error=e?.message||String(e);}finally{busy=false;render();
    const target=root&&((error&&root.querySelector('[role=alert]'))||(review&&root.querySelector('[data-vault=sign]'))||(focusKey&&root.querySelector(focusKey))||root.querySelector('[role=status]'));
    if(target){if(!target.matches('button'))target.tabIndex=-1;target.focus({preventScroll:false});}}}
  async function load(){const account=wallet().account,revision=epoch;const result=await api('/api/vault/containers',{account,chainId:status.chainId});if(revision===epoch)data=result;message='';}
  async function prepare(action,id){
    const account=wallet().account,revision=epoch,c=[...(data?.recipient??[]),...(data?.allocator??[])].find(x=>x.id===id);
    const body={account,chainId:status.chainId,action,id};
    if(action==='extend'){const days=Number(root.querySelector('[data-vault-days]')?.value);if(!Number.isInteger(days)||days<1||days>365)throw new Error(L('feeVault.enter1365Days'));extendDays=days;body.deadline=Math.min(Math.max(c.deadline,data.blockTimestamp)+days*86400,data.blockTimestamp+365*86400-60);}
    const r=await api('/api/vault/prepare',body);if(revision!==epoch)throw new Error(L('advancedLaunch.walletChangedReviewAgain'));review=r;
  }
  async function sign(){
    const r=review,revision=epoch,p=await bound(r.account,revision);
    if(Date.now()>r.expiresAt){review=null;throw new Error(L('feeVault.preparationExpiredPrepareAgain'));}
    const txHash=await p.request({method:'eth_sendTransaction',params:[r.transaction]});
    message=L('feeVault.submittedWaiting3Confirmations');review=null;render();
    for(let i=0;i<120&&root&&revision===epoch;i++){
      const s=await api('/api/vault/submit',{id:r.id,txHash,account:r.account,chainId:status.chainId});
      if(s.status==='confirmed'){message=L('feeVault.confirmedChain');await load();return;}
      if(s.status==='reverted')throw new Error(L('feeVault.transactionRevertedNothingMoved'));
      await new Promise(res=>setTimeout(res,3000));
    }
  }
  function click(event){
    const b=event.target.closest('[data-vault]');if(!b||!root.contains(b))return;const a=b.dataset.vault;
    if(a==='connect')return void connect();
    if(a==='refresh')return void run(load,'[data-vault=refresh]');
    if(a==='cancel'){review=null;return render();}
    if(a==='sign')return void run(sign);
    void run(()=>prepare(a,b.dataset.id));
  }
  async function mount(target){
    destroy();root=target;if(!root)throw new Error('Fee vault mount root not found.');root.addEventListener('click',click);watch();render();
    const revision=epoch;try{const s=await api('/api/vault/status');if(revision===epoch){status=s;render();}}catch(e){if(revision===epoch&&e?.name!=='AbortError'){status={deployed:false};error=e.message;render();}}
  }
  function destroy(){epoch++;for(const c of requests)c.abort();requests.clear();provider?.removeListener?.('accountsChanged',invalidate);provider?.removeListener?.('chainChanged',invalidate);provider=null;root?.removeEventListener('click',click);root=null;review=null;}
  return {mount,invalidate,destroy};
}
