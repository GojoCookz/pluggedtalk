import { NETWORK,QUOTES } from '../lib/config.mjs';
import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { mediaUploader } from './media.js';
import { translate } from './i18n.js';

// Reuse the existing product's form grid and receipt rail; no new UI framework.
export function launchScreen({wallet,connect,language,esc,onConfirmed}) {
  const L=(key,args)=>translate(language(),key,args);
  let input={name:'',symbol:'',quote:'0x5fc5360d0400a0fd4f2af552add042d716f1d168',imageCid:'',openingBuy:'1',milestoneUsd:'40000',feeBps:200,creatorBps:10000,feeRecipient:''};
  try{input={...input,...JSON.parse(localStorage.getItem('plugged.liveDraft')||'{}')};}catch{}
  let epoch=0,busy=false,prepared=null,funding=null,message='',error='',pending=null,hostRoot=null,activeRun=null,applyingPinned=false;
  try{pending=JSON.parse(localStorage.getItem('plugged.pendingLaunch')||'null');}catch{}
  const root=()=>hostRoot?.isConnected?hostRoot:null;
  const uploader=mediaUploader({language,esc,onPinned:result=>{
    const field=root()?.querySelector('[name=imageCid]');if(!field)return;
    field.value=result.cid;applyingPinned=true;try{field.dispatchEvent(new Event('input',{bubbles:true}));}finally{applyingPinned=false;}
  }});
  const quote=()=>QUOTES.find(q=>q.address===input.quote&&!q.native);
  const save=()=>localStorage.setItem('plugged.liveDraft',JSON.stringify(input));
  const recoveryId=()=>{try{return localStorage.getItem('plugged.launchRecoveryId');}catch{return null;}};
  function invalidate(){epoch++;prepared=null;funding=null;error='';message='';const receipt=document.querySelector('#funding-receipt');if(receipt)receipt.textContent='';update();}
  async function api(path,body){const r=await fetch('/api/launches/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const d=await r.json();if(!r.ok)throw new Error(d.error||L('advancedLaunch.requestFailedRetry'));return d;}
  function capture(){const form=document.querySelector('#live-form');if(!form)return;const data=new FormData(form);for(const key of Object.keys(input))if(data.has(key))input[key]=['feeBps','creatorBps'].includes(key)?Number(data.get(key)):String(data.get(key));}
  const line=(label,value)=>`<div class="receipt-line"><span>${label}</span><strong>${esc(value)}</strong></div>`;
  const button=(action,key)=>`<button type="button" class="primary" data-live="${action}" ${busy?'disabled':''}>${L(key)}</button>`;
  function update(){
    if(!root())return;
    document.querySelector('#launch-status').textContent=error||message;
    document.querySelector('#launch-status').className=error?'error-list':'receipt-note';
    root().querySelectorAll('[data-live],#live-form input,#live-form select,#live-form button[type=submit]').forEach(e=>{if(!e.closest('#launch-media'))e.disabled=busy;});
    root().querySelector('#launch-media').disabled=busy;
    const target=document.querySelector('#live-receipt'),q=quote(),r=prepared;
    let html=`<h2>${L('launch.launchReceipt')}</h2>${line(L('launch.openingTarget'),'$2,500 USD')}${line(L('advancedLaunch.supply'),'1,000,000,000')}`;
    if(r&&q){
      html+=line(L('launch.walletBalance'),`${formatUnits(BigInt(r.balance),q.decimals)} ${q.symbol}`)+line(L('advancedLaunch.openingPurchase'),`${input.openingBuy} ${q.symbol}`)+line(L('advancedLaunch.tradingFee'),`${r.input.feeBps/100}%`)+line(L('launch.platformVolume'),`${r.fees.platformVolumeBps/100}%`)+line(L('launch.creatorRemainingFees'),`${r.input.creatorBps/100}%`);
      html+=`<p class="receipt-note">${L('launch.tickRoundedOpening')}: ${esc(formatUnits(BigInt(r.opening.realisedMarketCap),q.decimals))} ${esc(q.symbol)}. ${L('advancedLaunch.usdConversionEstimate')}</p><p class="receipt-note">${L('advancedLaunch.reviewExpires')}: ${new Date(r.expiresAt).toLocaleTimeString(language())}</p>`;
      if(r.next==='fund')html+=`<p>${L('launch.fundWalletSelectedQuote')}</p>`;
      if(r.next==='approve')html+=BigInt(r.allowance)>0n?button('approve','launch.resetExistingApproval'):button('approve','launch.approveOpeningPurchase');
      if(r.next==='launch')html+=`<p class="gain">${L('advancedLaunch.launchSimulationPassed')}</p>`+button('launch','launch.signLaunchTransaction');
    }else html+=`<p class="receipt-note">${L('launch.reviewChecksPairRefreshes')}</p>`;
    html+=`<p class="receipt-note">${L('launch.3OrdinaryWalletCap')}</p>`;
    if(pending)html+=`<p class="receipt-note"><a class="text-link" href="${NETWORK.explorer}/tx/${esc(pending.txHash)}" target="_blank" rel="noopener noreferrer">${esc(pending.txHash)}</a></p>`+button('confirm','advancedLaunch.checkConfirmation');
    else if(recoveryId())html+=`<details><summary>${L('advancedLaunch.recoverSentLaunch')}</summary><label class="field">${L('advancedLaunch.transactionHashFromWallet')}<input id="recovery-hash" name="transactionHash" autocomplete="off" spellcheck="false" maxlength="66" placeholder="0x…"></label>${button('recover','advancedLaunch.checkTransaction')}</details>`;
    target.innerHTML=html;
  }
  function destroy(){capture();epoch++;prepared=null;funding=null;message='';error='';uploader.destroy();hostRoot=null;}
  function mount(target=document.querySelector('#main')){
    destroy();
    const field=(key,label,extra='')=>`<label class="field">${label}<input name="${key}" autocomplete="off" spellcheck="false" value="${esc(input[key])}" ${extra}></label>`;
    target.innerHTML=`<div id="live-launch"><div class="page-top"><div><h1>${L('launch.launchCoin')}</h1><p>${L('launch.carbonSRobinhoodEngine')}</p></div><span class="form-actions"><a class="text-link" href="#advanced/launch">${L('launch.advancedMultiPoolLaunch')}</a><a class="text-link" href="#planner">${L('launch.extendedFeaturePlanner')}</a></span></div>
      <div class="form-layout"><div><form id="live-form"><section class="form-section"><h2>${L('launch.makeYours')}</h2><div class="fields">${field('name',L('advancedLaunch.name'),'maxlength="64" required')}${field('symbol',L('advancedLaunch.ticker'),'maxlength="12" pattern="[A-Za-z0-9]{1,12}" required')}
      <fieldset id="launch-media" class="full"><legend>${L('advancedLaunch.launchImage')}</legend><div id="launch-media-root"></div></fieldset>
      <details class="full cid-details" ${input.imageCid?'open':''}><summary>${L('advancedLaunch.iAlreadyHaveImage')}</summary><p class="receipt-note">${L('advancedLaunch.ipfsPublicFileStorage')}</p><label class="field">${L('advancedLaunch.imageContentId')}<input name="imageCid" maxlength="100" placeholder="bafkrei… / Qm…" value="${esc(input.imageCid)}"></label></details></div></section>
      <section class="form-section"><h2>${L('launch.marketOpeningPurchase')}</h2><div class="fields"><label class="field full">${L('launch.pairingCoin')}<select name="quote">${QUOTES.filter(q=>!q.native).map(q=>`<option value="${q.address}" ${q.address===input.quote?'selected':''}>${esc(q.symbol)} · ${q.address.slice(0,8)}…${q.address.slice(-4)}</option>`).join('')}</select></label>
      ${field('openingBuy',L('launch.openingPurchasePairingCoin'),'inputmode="decimal" required')}${field('milestoneUsd',L('launch.milestoneUsd'),'inputmode="decimal" required')}</div><p class="receipt-note">${L('launch.pairingCoinContract')}:</p><p class="address-block" id="live-quote-address">${esc(input.quote)}</p><p class="receipt-note">${L('launch.everyCoinOpensAt')}</p></section>
      <section class="form-section"><h2>${L('launch.feesRewards')}</h2><p class="receipt-note">${L('launch.carbonKeeps1Every')}</p><div class="fields">${field('feeBps',L('advancedLaunch.totalTradingFee200'),'type="number" min="101" max="1000" step="1" required')}
      <label class="field">${L('advancedLaunch.creatorShareRemainingFees')}<select name="creatorBps">${[0,2500,5000,7500,10000].map(n=>`<option value="${n}" ${n===input.creatorBps?'selected':''}>${n/100}% ${L('advancedLaunch.creator')} / ${100-n/100}% ${L('advancedLaunch.holders')}</option>`).join('')}</select></label><label class="field full">${L('launch.creatorFeeWalletOptional')}<input name="feeRecipient" placeholder="${L('launch.defaultsConnectedWallet')}" value="${esc(input.feeRecipient)}" maxlength="42" pattern="0x[0-9a-fA-F]{40}" title="${L('launch.feeRecipientFormat')}"></label></div></section>
      <button type="submit" class="primary">${L('launch.reviewLaunch')}</button><p class="receipt-note">${L('launch.termsDraftNotice')} <a class="text-link" href="#terms">${L('welcome.terms')}</a> · <a class="text-link" href="#privacy">${L('welcome.privacy')}</a></p></form>
      <details class="form-section funding-section"><summary>${L('launch.fundEth')}</summary><p>${L('launch.swapRobinhoodNativeEth')}</p><label class="field">ETH<input id="live-eth" inputmode="decimal" value="0.001"></label><button type="button" data-live="funding">${L('launch.reviewEthSwap')}</button><div id="funding-receipt" aria-live="polite"></div></details><p id="launch-status" role="status" aria-live="polite"></p></div><aside id="live-receipt" class="plan-receipt rail-panel" aria-label="${L('launch.launchReceipt')}"></aside></div></div>`;
    hostRoot=target.querySelector('#live-launch');const host=root();host.querySelectorAll('input').forEach(el=>{el.autocomplete='off';el.spellcheck=false;});host.addEventListener('input',event=>{
      if(event.target.closest('#live-form')&&!event.target.closest('#launch-media')){capture();if(event.target.name==='imageCid'&&!applyingPinned){uploader.destroy();uploader.mount(host.querySelector('#launch-media-root'));}if(event.target.name==='quote'){input.openingBuy='';host.querySelector('[name=openingBuy]').value='';host.querySelector('#live-quote-address').textContent=input.quote;}invalidate();try{save();}catch{error=L('advancedLaunch.enableBrowserStorageBefore');update();}}
      if(event.target.id==='live-eth'){epoch++;funding=null;host.querySelector('#funding-receipt').textContent='';}
    });
    host.addEventListener('submit',event=>{if(event.target.id==='live-form'){event.preventDefault();run('prepare');}});
    host.addEventListener('click',event=>{const button=event.target.closest('[data-live]');if(button)run(button.dataset.live);});uploader.mount(host.querySelector('#launch-media-root'));update();
  }
  async function walletFor(expected,revision){
    const {account,provider}=wallet();if(!provider||account?.toLowerCase()!==expected.toLowerCase()||epoch!==revision)throw new Error(L('advancedLaunch.walletFormChangedReview'));
    const chain=await provider.request({method:'eth_chainId'});
    if(Number(chain)!==4663)throw new Error(L('advancedLaunch.switchRobinhoodChain4663'));
    const accounts=await provider.request({method:'eth_accounts'});if(accounts?.[0]?.toLowerCase()!==expected.toLowerCase()||epoch!==revision)throw new Error(L('advancedLaunch.walletChangedReviewAgain'));return provider;
  }
  async function send(transaction,expiresAt,revision){const provider=await walletFor(transaction.from,revision);if(Date.now()>=expiresAt)throw new Error(L('advancedLaunch.reviewExpiredReviewAgain'));save();return provider.request({method:'eth_sendTransaction',params:[transaction]});}
  async function waitReceipt(provider,hash){
    for(let i=0;i<60;i++){const r=await provider.request({method:'eth_getTransactionReceipt',params:[hash]});if(r){if(r.status!=='0x1')throw new Error(L('advancedLaunch.transactionRevertedCheckWallet'));return;}await new Promise(r=>setTimeout(r,2000));}
    throw new Error(L('advancedLaunch.stillPendingCheckWallet'));
  }
  async function run(action){
    if(root()?.querySelector('[data-media-action=cancel]:not([hidden])')){error=L('advancedLaunch.waitImageUploadCancel');update();return;}
    if(busy)return;if(!wallet().account&&!['confirm','recover'].includes(action)){await connect();return;}
    if(action==='prepare'&&!document.querySelector('#live-form').reportValidity())return;
    capture();const operation={},revision=epoch,account=wallet().account,recoveryHash=document.querySelector('#recovery-hash')?.value;activeRun=operation;busy=true;error='';message=L('advancedLaunch.checking');update();
    try{
      if(action==='prepare'){
        if(pending)throw new Error(L('advancedLaunch.confirmPendingLaunchBefore'));
        await walletFor(account,revision);save();const r=await api('prepare',{...input,account});if(epoch!==revision)return;prepared=r;message=L('advancedLaunch.reviewReadyContinueNext');
      }else if(action==='approve'||action==='launch'){
        const r=prepared;if(!r)throw new Error(L('advancedLaunch.reviewLaunchFirst'));
        const tx=action==='approve'?r.approval:r.transaction;if(!tx||tx.from.toLowerCase()!==account.toLowerCase())throw new Error('Transaction/account mismatch.');
        const provider=wallet().provider;if(action==='launch')localStorage.setItem('plugged.launchRecoveryId',r.id);
        const hash=await send(tx,r.expiresAt,revision);
        if(action==='launch'){
           pending={id:r.id,txHash:hash};localStorage.setItem('plugged.pendingLaunch',JSON.stringify(pending));prepared=null;await handleConfirmation(await api('submit',pending),revision);
        }else{message=L('advancedLaunch.approvalSentWaitingConfirmation');update();await waitReceipt(provider,hash);if(epoch===revision){prepared=null;message=L('launch.approvalConfirmedReviewAgain');}}
      }else if(action==='funding'){
        const amountEth=document.querySelector('#live-eth').value;await walletFor(account,revision);const r=await api('funding',{account,quote:input.quote,amountEth,slippageBps:50});if(epoch!==revision)return;funding=r;
        document.querySelector('#funding-receipt').innerHTML=`<p>${esc(amountEth)} ETH → ${esc(formatUnits(BigInt(r.outputAmount),quote().decimals))} ${esc(quote().symbol)}. ${L('launch.minimum')}: ${esc(formatUnits(BigInt(r.minimumOutput),quote().decimals))}. LI.FI · 0.5% ${L('launch.slippage')}.</p>`+button('swap','launch.signEthFundingSwap');message='';
      }else if(action==='swap'){
        if(!funding)throw new Error(L('launch.reviewSwapFirst'));const provider=wallet().provider,hash=await send(funding.transaction,Date.parse(funding.expiresAt),revision);funding=null;
        message=L('launch.fundingSentWaitingConfirmation');update();await waitReceipt(provider,hash);
        if(epoch===revision){prepared=null;document.querySelector('#funding-receipt').textContent='';message=L('launch.fundingConfirmedReviewLaunch');}
       }else if(action==='confirm'&&pending)await handleConfirmation(await api('submit',pending),revision);
      else if(action==='recover'){
        const txHash=recoveryHash,id=recoveryId();
        if(!id||!/^0x[0-9a-f]{64}$/i.test(txHash??''))throw new Error(L('advancedLaunch.pasteCompleteTransactionHash'));
         const r=await api('submit',{id,txHash});pending={id,txHash};localStorage.setItem('plugged.pendingLaunch',JSON.stringify(pending));await handleConfirmation(r,revision);
      }
    }catch(e){if(epoch===revision)error=e.message;}
    finally{if(activeRun===operation){activeRun=null;busy=false;update();if(root()&&epoch===revision){const target=document.querySelector(error?'#launch-status':action==='prepare'?'#live-receipt':'#launch-status');target.tabIndex=-1;target.focus({preventScroll:true});if(innerWidth<781)target.scrollIntoView({block:'center'});}}}
  }
  async function handleConfirmation(r,revision){
    if(r.status==='confirmed'){if(epoch===revision)message=L('launch.launchConfirmedCoinListed');pending=null;localStorage.removeItem('plugged.pendingLaunch');localStorage.removeItem('plugged.launchRecoveryId');await onConfirmed();}
    else if(r.status==='reverted'||r.status==='duplicate'){if(epoch===revision)error=L('advancedLaunch.transactionInspectWallet',{p0:r.status});pending=null;localStorage.removeItem('plugged.pendingLaunch');}
    else if(epoch===revision)message=L('advancedLaunch.submittedCheckConfirmationAfter');
  }
  return {mount,invalidate,destroy};
}
