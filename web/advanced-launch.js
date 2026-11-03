import { NETWORK,QUOTES } from '../lib/config.mjs';
import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { mediaUploader } from './media.js';
import { serverError, translate } from './i18n.js';

// Advanced multi-market launch. Same form grid, receipt rail and wallet rules as the Carbon screen;
// the server refuses every preparation unless a verified plugged-advanced-v1 deployment exists.
export function advancedLaunchScreen({wallet,connect,language,esc,onConfirmed}) {
  const L=(key,args)=>translate(language(),key,args);
  const erc20=QUOTES.filter(q=>!q.native);
  const blank=()=>({name:'',symbol:'',imageCid:'',milestoneUsd:'40000',feeBps:200,creatorBps:10000,vestDays:0,cliffDays:0,markets:[{quote:erc20[0]?.address??'',openingBuy:''}],recipients:[]});
  let input=blank();
  try{const saved=JSON.parse(localStorage.getItem('plugged.advancedDraft')||'null');if(saved&&Array.isArray(saved.markets)&&Array.isArray(saved.recipients))input={...input,...saved};}catch{}
  let previewForm=false,epoch=0,busy=false,prepared=null,message='',error='',pending=null,hostRoot=null,activeRun=null,config=null,applyingPinned=false,vault=null;
  try{pending=JSON.parse(localStorage.getItem('plugged.pendingAdvanced')||'null');}catch{}
  const root=()=>hostRoot?.isConnected?hostRoot:null;
  const $=selector=>root()?.querySelector(selector);
  const uploader=mediaUploader({language,esc,onPinned:result=>{const field=$('[name=imageCid]');if(!field)return;field.value=result.cid;applyingPinned=true;try{field.dispatchEvent(new Event('input',{bubbles:true}));}finally{applyingPinned=false;}}});
  const save=()=>localStorage.setItem('plugged.advancedDraft',JSON.stringify(input));
  const recoveryId=()=>{try{return localStorage.getItem('plugged.advancedRecoveryId');}catch{return null;}};
  const available=()=>config?.available===true;
  async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const d=await r.json();if(!r.ok)throw new Error(d.error?serverError(d.error,language()):L('advancedLaunch.requestFailedRetry'));return d;}
  const api=(path,body)=>post('/api/advanced/'+path,body);
  const vaultApi=(path,body)=>post('/api/vault/'+path,body);
  const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
  const key=()=>Math.random().toString(36).slice(2,10);
  // A container holds exactly one currency, but the factory gives every quote pool's splitter the
  // same recipient list. A container inbox is therefore only correct in single-quote launches.
  function holdReason(){
    if(!vault)return L('advancedLaunch.checkingFeeVault');
    if(!vault.deployed)return serverError(vault.reason||'Fee vault is not deployed or not configured on this server.',language());
    if(input.markets.length!==1)return L('advancedLaunch.containerHoldsOneCurrency');
    return null;
  }
  function containerProblem(){
    for(const [i,r] of input.recipients.entries()){
      if(r.hold&&!r.container)return L('advancedLaunch.recipientCreateItsContainer',{p0:i+1});
      if(r.container&&(input.markets.length!==1||!same(r.container.currency,input.markets[0].quote)))return L('advancedLaunch.recipientItsContainerHolds',{p0:i+1});
    }
    return null;
  }
  function invalidate(){epoch++;prepared=null;error='';message='';update();}
  function capture(){
    const form=$('#advanced-form');if(!form)return;const data=new FormData(form);
    for(const key of ['name','symbol','imageCid','milestoneUsd'])if(data.has(key))input[key]=String(data.get(key));
    for(const key of ['feeBps','creatorBps','vestDays','cliffDays'])if(data.has(key))input[key]=Number(data.get(key));
    input.markets=[...form.querySelectorAll('[data-market]')].map(row=>({quote:row.querySelector('select').value,openingBuy:row.querySelector('input').value.trim()}));
    input.recipients=[...form.querySelectorAll('[data-recipient]')].map(row=>{
      const prev=input.recipients[Number(row.dataset.recipient)]??{},hold=row.querySelector('[name=recipientHold]')?.checked===true,windowInput=row.querySelector('[name=recipientWindow]');
      const r={key:prev.key??key(),address:row.querySelector('[name=recipientAddress]').value.trim(),bps:Number(row.querySelector('[name=recipientBps]').value),hold,windowDays:windowInput?Number(windowInput.value):(prev.windowDays??30)};
      if(prev.container&&hold)r.container=prev.container;
      // Turning holding off restores the payout wallet; the on-chain container stays reclaimable by you.
      else if(prev.container)r.address=prev.container.recipient;
      if(prev.pendingTx&&hold&&!r.container)r.pendingTx=prev.pendingTx;
      return r;
    });
  }
  const line=(label,value)=>`<div class="receipt-line"><span>${label}</span><strong>${esc(value)}</strong></div>`;
  const button=(action,key,extra='',args)=>`<button type="button" class="primary" data-advanced="${action}" ${extra} ${busy?'disabled':''}>${L(key,args)}</button>`;
  function marketRows(){
    return input.markets.map((m,i)=>`<div class="fields" data-market="${i}"><label class="field">${L('advancedLaunch.quote')} ${i+1}<select name="marketQuote">${erc20.map(q=>`<option value="${q.address}" ${q.address===m.quote?'selected':''}>${esc(q.symbol)} · ${q.address.slice(0,8)}…${q.address.slice(-4)}</option>`).join('')}</select></label>
      <label class="field">${L('advancedLaunch.openingPurchase')}<input name="marketBuy" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(m.openingBuy)}" required></label>
      ${input.markets.length>1?`<button type="button" data-advanced="remove-market" data-index="${i}">${L('advancedLaunch.remove')}</button>`:''}</div>`).join('');
  }
  function recipientRows(){
    if(!input.recipients.length)return `<p class="receipt-note">${L('advancedLaunch.noRows100Creator')}</p>`;
    const reason=holdReason();
    const note=`<p id="advanced-hold-note" class="receipt-note">${esc(reason?L('advancedLaunch.reclaimableContainersUnavailable')+reason:L('advancedLaunch.optionalHoldRecipientS'))}</p>`;
    return note+input.recipients.map((r,i)=>{
      const c=r.container,label=c?L('advancedLaunch.containerInbox',{p0:i+1}):r.hold?L('advancedLaunch.recipientPayoutWallet',{p0:i+1}):`${L('advancedLaunch.wallet')} ${i+1}`;
      const until=c?new Intl.DateTimeFormat(language(),{dateStyle:'medium'}).format(new Date(c.deadline*1000)):'';
      return `<div class="fields" data-recipient="${i}"><label class="field">${label}<input name="recipientAddress" autocomplete="off" spellcheck="false" maxlength="42" placeholder="0x…" value="${esc(r.address)}" required ${c?`readonly aria-describedby="container-note-${i}"`:''}></label>
      <label class="field">${L('advancedLaunch.share10000100')}<input name="recipientBps" type="number" min="1" max="10000" step="1" value="${esc(r.bps)}" required></label>
      <div class="field full"><label class="toggle"><input type="checkbox" name="recipientHold" ${r.hold?'checked':''} aria-describedby="advanced-hold-note">${L('advancedLaunch.holdReclaimableContainer')}</label></div>
      ${r.hold&&!c?`<label class="field">${L('advancedLaunch.responseWindowDays7')}<input name="recipientWindow" type="number" min="7" max="365" step="1" value="${esc(r.windowDays??30)}" required></label><div class="field"><button type="button" data-advanced="${r.pendingTx?'check-container':'create-container'}" data-index="${i}">${r.pendingTx?L('advancedLaunch.checkContainerConfirmation'):L('advancedLaunch.createContainer')}</button></div>`:''}
      ${c?`<div class="field full"><p id="container-note-${i}" class="address-block">${L('advancedLaunch.containerFeesGoInbox',{p0:esc(c.id),p1:esc(c.recipient),p2:until})}</p></div>`:''}
      <button type="button" data-advanced="remove-recipient" data-index="${i}">${L('advancedLaunch.remove')}</button></div>`;}).join('');
  }
  function update(){
    if(!root())return;
    const status=$('#advanced-status');status.textContent=error||message;status.className=error?'error-list':'receipt-note';
    root().querySelectorAll('[data-advanced],#advanced-form input,#advanced-form select,#advanced-form button').forEach(e=>{if(!e.closest('#advanced-media'))e.disabled=busy||(!available()&&!['confirm','recover'].includes(e.dataset.advanced))||(e.name==='recipientHold'&&!e.checked&&Boolean(holdReason()))||(e.dataset.advanced==='create-container'&&Boolean(holdReason()));});
    const total=input.recipients.reduce((s,r)=>s+(Number(r.bps)||0),0);
    const sum=$('#recipient-sum');if(sum)sum.textContent=input.recipients.length?`${L('advancedLaunch.total')}: ${total} / 10000 bps`:'';
    const banner=$('#advanced-banner'),layout=$('#advanced-layout'),off=Boolean(config)&&!available();
    if(layout&&off&&!previewForm)layout.hidden=true;else if(layout)layout.hidden=false;
    if(banner)banner.innerHTML=off?`<div class="callout" role="status"><strong>${L('advancedLaunch.advancedLaunchNotAvailable')}</strong>${esc(/profile is configured/.test(config.reason||'')?L('advancedLaunch.serverHasNoVerified'):serverError(config.reason,language())||L('advancedLaunch.advancedDeploymentUnavailable'))} <a class="text-link" href="#create">${L('advancedLaunch.useStandardLaunch')}</a></div>${layout?.hidden?`<button type="button" data-show-advanced>${L('advancedLaunch.previewForm')}</button>`:''}`:'';
    const r=prepared;
    let html=`<h2>${L('advancedLaunch.advancedReceipt')}</h2>${line(L('advancedLaunch.openingTargetAllPools'),'$2,500 USD')}${line(L('advancedLaunch.pools'),String(input.markets.length))}${line(L('advancedLaunch.walletCap'),L('advancedLaunch.3NoExemptionsCreator'))}`;
    const held=input.recipients.filter(x=>x.container).length;if(held)html+=line(L('advancedLaunch.recipientsHeldContainers'),String(held));
    if(r){
      html+=line(L('advancedLaunch.supply'),formatUnits(BigInt(r.params.supply),18))+line(L('advancedLaunch.canonicalName'),r.canonical.name)+line(L('advancedLaunch.canonicalTicker'),r.canonical.symbol)+line(L('advancedLaunch.tradingFee'),`${r.input.feeBps/100}%`)+line(L('advancedLaunch.creatorShare'),`${r.input.creatorBps/100}%`);
      for(const m of r.markets)html+=line(`${esc(m.symbol)} ${L('advancedLaunch.balanceNeeded')}`,`${formatUnits(BigInt(m.balance),m.decimals)} / ${formatUnits(BigInt(m.required),m.decimals)}`);
      html+=`<p class="receipt-note">${L('advancedLaunch.reviewExpires')}: ${new Date(r.expiresAt).toLocaleTimeString(language())}. ${L('advancedLaunch.usdConversionEstimate')}</p>`;
      if(r.next==='fund')html+=`<p>${L('advancedLaunch.fundWalletEverySelected')}</p>`;
      if(r.next==='approve')html+=r.approvals.map((a,i)=>button('approve',a.reset?'advancedLaunch.resetSymbol':'advancedLaunch.approveSymbol',`data-index="${i}"`,{symbol:a.symbol})).join('')+`<p class="receipt-note">${L('advancedLaunch.approveEachQuoteThen')}</p>`;
      if(r.next==='launch')html+=`<p class="gain">${L('advancedLaunch.launchSimulationPassed')}</p>`+button('launch','advancedLaunch.signAdvancedLaunch');
    }else html+=`<p class="receipt-note">${L('advancedLaunch.reviewVerifiesDeploymentChecks')}</p>`;
    html+=`<p class="receipt-note">${L('advancedLaunch.capLimitsEachAddress')}</p>`;
    if(pending)html+=`<p class="receipt-note"><a class="text-link" href="${NETWORK.explorer}/tx/${esc(pending.txHash)}" target="_blank" rel="noopener noreferrer">${esc(pending.txHash)}</a></p>`+button('confirm','advancedLaunch.checkConfirmation');
    else if(recoveryId())html+=`<details><summary>${L('advancedLaunch.recoverSentLaunch')}</summary><label class="field">${L('advancedLaunch.transactionHashFromWallet')}<input id="advanced-recovery-hash" name="transactionHash" autocomplete="off" spellcheck="false" maxlength="66" placeholder="0x…"></label>${button('recover','advancedLaunch.checkTransaction')}</details>`;
    $('#advanced-receipt').innerHTML=html;
  }
  function renderLists(){const m=$('#advanced-markets'),r=$('#advanced-recipients');if(m)m.innerHTML=marketRows();if(r)r.innerHTML=recipientRows();$('[data-advanced=add-market]').hidden=input.markets.length>=4;$('[data-advanced=add-recipient]').hidden=input.recipients.length>=50;}
  function destroy(){capture();epoch++;prepared=null;message='';error='';uploader.destroy();hostRoot=null;}
  function mount(target=document.querySelector('#main')){
    destroy();
    const field=(key,label,extra='')=>`<label class="field">${label}<input name="${key}" autocomplete="off" spellcheck="false" value="${esc(input[key])}" ${extra}></label>`;
    target.innerHTML=`<div id="advanced-launch"><div class="page-top"><div><h1>${L('advancedLaunch.advancedLaunch')}</h1><p>${L('advancedLaunch.upFourPairingPools')}</p></div><a class="text-link" href="#create">${L('advancedLaunch.standardCarbonLaunch')}</a></div>
      <div id="advanced-banner"></div><div class="form-layout" id="advanced-layout"><div><form id="advanced-form" novalidate><section class="form-section"><h2>${L('advancedLaunch.identity')}</h2><div class="fields">${field('name',L('advancedLaunch.name'),'maxlength="64" required')}${field('symbol',L('advancedLaunch.ticker'),'maxlength="12" pattern="[A-Za-z0-9]{1,12}" required')}
      <fieldset id="advanced-media" class="full"><legend>${L('advancedLaunch.launchImage')}</legend><div id="advanced-media-root"></div></fieldset>
      <details class="full cid-details" ${input.imageCid?'open':''}><summary>${L('advancedLaunch.iAlreadyHaveImage')}</summary><p class="receipt-note">${L('advancedLaunch.ipfsPublicFileStorage')}</p><label class="field">${L('advancedLaunch.imageContentId')}<input name="imageCid" maxlength="100" autocomplete="off" spellcheck="false" placeholder="bafkrei… / Qm…" value="${esc(input.imageCid)}"></label></details></div>
      <p class="receipt-note">${L('advancedLaunch.nameTickerCanonicalizedChain')}</p></section>
      <section class="form-section"><h2>${L('advancedLaunch.quotePools')}</h2><p class="receipt-note">${L('advancedLaunch.oneFourUniqueQuotes')}</p><div id="advanced-markets"></div><button type="button" data-advanced="add-market">${L('advancedLaunch.addQuotePool')}</button>
      <div class="fields">${field('milestoneUsd',L('advancedLaunch.milestoneAllPoolsUsd'),'inputmode="decimal" required')}</div></section>
      <section class="form-section"><h2>${L('advancedLaunch.feesRecipients')}</h2><div class="fields">${field('feeBps',L('advancedLaunch.totalTradingFee200'),'type="number" min="101" max="1000" step="1" required')}
      <label class="field">${L('advancedLaunch.creatorShareRemainingFees')}<select name="creatorBps">${[0,2500,5000,7500,10000].map(n=>`<option value="${n}" ${n===input.creatorBps?'selected':''}>${n/100}% ${L('advancedLaunch.creator')} / ${100-n/100}% ${L('advancedLaunch.holders')}</option>`).join('')}</select></label></div>
      <div id="advanced-recipients"></div><p id="recipient-sum" class="receipt-note" aria-live="polite"></p><button type="button" data-advanced="add-recipient">${L('advancedLaunch.addRecipient')}</button></section>
      <section class="form-section"><h2>${L('advancedLaunch.creatorVesting')}</h2><div class="fields">${field('vestDays',L('advancedLaunch.vestingDays0Off'),'type="number" min="0" max="3650" step="1"')}${field('cliffDays',L('advancedLaunch.cliffDays'),'type="number" min="0" max="3650" step="1"')}</div><p class="receipt-note">${L('advancedLaunch.knownLimitIfSomeone')}</p></section>
      <button type="submit" class="primary">${L('advancedLaunch.reviewAdvancedLaunch')}</button></form><p id="advanced-status" role="status" aria-live="polite"></p></div>
      <aside id="advanced-receipt" class="plan-receipt rail-panel" aria-label="${L('advancedLaunch.advancedReceipt')}"></aside></div></div>`;
    hostRoot=target.querySelector('#advanced-launch');const host=root();renderLists();
    host.addEventListener('input',event=>{
      if(!event.target.closest('#advanced-form')||event.target.closest('#advanced-media'))return;
      capture();if(event.target.name==='imageCid'&&!applyingPinned){uploader.destroy();uploader.mount($('#advanced-media-root'));}
      if(event.target.name==='recipientHold'){const i=event.target.closest('[data-recipient]').dataset.recipient;renderLists();$(`[data-recipient="${i}"] [name=recipientHold]`)?.focus();}
      invalidate();try{save();}catch{error=L('advancedLaunch.enableBrowserStorageBefore');update();}
    });
    host.addEventListener('submit',event=>{if(event.target.id==='advanced-form'){event.preventDefault();run('prepare');}});
    host.addEventListener('click',event=>{if(event.target.closest('[data-show-advanced]')){previewForm=true;update();$('#advanced-layout input[name=name]')?.focus();return;}const b=event.target.closest('[data-advanced]');if(b)run(b.dataset.advanced,Number(b.dataset.index));});
    uploader.mount($('#advanced-media-root'));update();
    fetch('/api/advanced/config',{signal:AbortSignal.timeout(30000)}).then(r=>r.json()).catch(()=>({available:false,reason:L('advancedLaunch.advancedStatusUnavailableRetry')})).then(d=>{if(!root())return;config=d;update();});
    fetch('/api/vault/status',{signal:AbortSignal.timeout(30000)}).then(r=>r.json()).catch(()=>({deployed:false,reason:L('advancedLaunch.feeVaultStatusUnavailable')})).then(d=>{if(!root())return;vault=d;capture();renderLists();update();});
  }
  async function walletFor(expected,revision){
    const {account,provider}=wallet();if(!provider||account?.toLowerCase()!==expected.toLowerCase()||epoch!==revision)throw new Error(L('advancedLaunch.walletFormChangedReview'));
    if(Number(await provider.request({method:'eth_chainId'}))!==4663)throw new Error(L('advancedLaunch.switchRobinhoodChain4663'));
    const accounts=await provider.request({method:'eth_accounts'});if(accounts?.[0]?.toLowerCase()!==expected.toLowerCase()||epoch!==revision)throw new Error(L('advancedLaunch.walletChangedReviewAgain'));return provider;
  }
  async function send(transaction,expiresAt,revision){const provider=await walletFor(transaction.from,revision);if(Date.now()>=expiresAt)throw new Error(L('advancedLaunch.reviewExpiredReviewAgain'));save();return provider.request({method:'eth_sendTransaction',params:[transaction]});}
  async function waitReceipt(provider,hash){
    for(let i=0;i<60;i++){const r=await provider.request({method:'eth_getTransactionReceipt',params:[hash]});if(r){if(r.status!=='0x1')throw new Error(L('advancedLaunch.transactionRevertedCheckWallet'));return;}await new Promise(r=>setTimeout(r,2000));}
    throw new Error(L('advancedLaunch.stillPendingCheckWallet'));
  }
  async function run(action,index){
    if(['add-market','remove-market','add-recipient','remove-recipient'].includes(action)){
      capture();
      if(action==='add-market'&&input.markets.length<4)input.markets.push({quote:erc20.find(q=>!input.markets.some(m=>m.quote===q.address))?.address??erc20[0].address,openingBuy:''});
      if(action==='remove-market'&&input.markets.length>1)input.markets.splice(index,1);
      if(action==='add-recipient'&&input.recipients.length<100)input.recipients.push({key:key(),address:input.recipients.length?'':(wallet().account??''),bps:input.recipients.length?0:10000,hold:false,windowDays:30});
      if(action==='remove-recipient')input.recipients.splice(index,1);
      renderLists();invalidate();try{save();}catch{}return;
    }
    if($('[data-media-action=cancel]:not([hidden])')){error=L('advancedLaunch.waitImageUploadCancel');update();return;}
    if(busy)return;if(!wallet().account&&!['confirm','recover'].includes(action)){await connect();return;}
    if(action==='prepare'&&!$('#advanced-form').reportValidity())return;
    capture();const operation={},revision=epoch,account=wallet().account,recoveryHash=$('#advanced-recovery-hash')?.value;activeRun=operation;busy=true;error='';message=L('advancedLaunch.checking');update();
    try{
      if(action==='prepare'){
        if(!available())throw new Error(serverError(config?.reason,language())||L('advancedLaunch.advancedDeploymentUnavailable'));
        if(pending)throw new Error(L('advancedLaunch.confirmPendingLaunchBefore'));
        const problem=containerProblem();if(problem)throw new Error(problem);
        await walletFor(account,revision);save();
        const body={...input,account,recipients:input.recipients.map(x=>({address:x.address,bps:x.bps}))};if(!body.recipients.length)delete body.recipients;if(!body.creatorBps)body.recipients=[];
        const r=await api('prepare',body);if(epoch!==revision)return;prepared=r;message=L('advancedLaunch.reviewReadyContinueNext');
      }else if(action==='approve'||action==='launch'){
        const r=prepared;if(!r)throw new Error(L('advancedLaunch.reviewLaunchFirst'));
        const tx=action==='approve'?r.approvals[index]?.transaction:r.transaction;if(!tx||tx.from.toLowerCase()!==account.toLowerCase())throw new Error('Transaction/account mismatch.');
        const provider=wallet().provider;if(action==='launch')localStorage.setItem('plugged.advancedRecoveryId',r.id);
        const hash=await send(tx,r.expiresAt,revision);
        if(action==='launch'){pending={id:r.id,txHash:hash};localStorage.setItem('plugged.pendingAdvanced',JSON.stringify(pending));prepared=null;await handleConfirmation(await api('submit',pending),revision);}
        else{message=L('advancedLaunch.approvalSentWaitingConfirmation');update();await waitReceipt(provider,hash);if(epoch===revision){prepared=null;message=L('advancedLaunch.approvalConfirmedReviewAgain');}}
      }else if(action==='create-container'||action==='check-container'){
        const r=input.recipients[index];if(!r)throw new Error(L('advancedLaunch.recipientRowChangedRetry'));
        const reason=holdReason();if(reason&&action==='create-container')throw new Error(reason);
        const rowKey=r.key;let txHash=r.pendingTx?.txHash,prepId=r.pendingTx?.id;
        if(action==='create-container'){
          if(!/^0x[0-9a-fA-F]{40}$/.test(r.address))throw new Error(L('advancedLaunch.recipientEnterResolvedPayout',{p0:index+1}));
          if(!Number.isInteger(r.windowDays)||r.windowDays<7||r.windowDays>365)throw new Error(L('advancedLaunch.responseWindowWholeDays'));
          await walletFor(account,revision);
          const prep=await vaultApi('prepare',{account,chainId:4663,action:'create',recipient:r.address,currency:input.markets[0].quote,windowDays:r.windowDays});
          if(prep.transaction.from.toLowerCase()!==account.toLowerCase()||!same(prep.expected.currency,input.markets[0].quote)||!same(prep.expected.recipient,r.address))throw new Error('Transaction/account mismatch.');
          txHash=await send(prep.transaction,prep.expiresAt,revision);prepId=prep.id;
          r.pendingTx={id:prepId,txHash};try{save();}catch{}
        }
        message=L('advancedLaunch.containerTransactionSentWaiting');update();
        let done=null;
        for(let i=0;i<60&&!done;i++){
          const s=await vaultApi('submit',{txHash,account,chainId:4663});
          if(s.status==='confirmed')done=s;else if(s.status==='reverted'||s.status==='reorg'){const row=input.recipients.find(x=>x.key===rowKey);if(row)delete row.pendingTx;try{save();}catch{}throw new Error(L(s.status==='reorg'?'advancedLaunch.containerReorganized':'advancedLaunch.containerReverted'));}
          else await new Promise(res=>setTimeout(res,3000));
        }
        if(!done)throw new Error(L('advancedLaunch.containerStillConfirmingUse'));
        // Only the inbox from the confirmed ContainerCreated event (cross-checked against vault storage) is used.
        const row=input.recipients.find(x=>x.key===rowKey);
        if(row){row.container={id:String(done.containerId),inbox:done.inbox,recipient:done.recipient,currency:done.currency,deadline:done.deadline};row.address=done.inbox;row.hold=true;delete row.pendingTx;}
        try{save();}catch{}renderLists();prepared=null;epoch++;
        message=L('advancedLaunch.containerCreatedItsInbox',{p0:done.containerId,p1:index+1});
      }else if(action==='confirm'&&pending)await handleConfirmation(await api('status',{id:pending.id}),revision);
      else if(action==='recover'){
        const txHash=recoveryHash,id=recoveryId();
        if(!id||!/^0x[0-9a-f]{64}$/i.test(txHash??''))throw new Error(L('advancedLaunch.pasteCompleteTransactionHash'));
        const r=await api('submit',{id,txHash});pending={id,txHash};localStorage.setItem('plugged.pendingAdvanced',JSON.stringify(pending));await handleConfirmation(r,revision);
      }
    }catch(e){if(epoch===revision)error=e.message;}
    finally{if(activeRun===operation){activeRun=null;busy=false;update();if(root()&&epoch===revision){const target=$(error?'#advanced-status':action==='prepare'?'#advanced-receipt':'#advanced-status');target.tabIndex=-1;target.focus({preventScroll:true});if(innerWidth<781)target.scrollIntoView({block:'center'});}}}
  }
  async function handleConfirmation(r,revision){
    if(r.status==='confirmed'){if(epoch===revision)message=L('advancedLaunch.advancedLaunchConfirmedAppears',{p0:r.token});pending=null;localStorage.removeItem('plugged.pendingAdvanced');localStorage.removeItem('plugged.advancedRecoveryId');await onConfirmed?.();}
    else if(r.status==='reverted'||r.status==='duplicate'){if(epoch===revision)error=L('advancedLaunch.transactionInspectWallet',{p0:r.status});pending=null;localStorage.removeItem('plugged.pendingAdvanced');}
    else if(epoch===revision)message=L('advancedLaunch.submittedCheckConfirmationAfter');
  }
  return {mount,invalidate,destroy};
}
