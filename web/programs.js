import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { translate } from './i18n.js';

// Operate mode: extend Plugged's existing white/green receipt surface and system type.
// Funds and fixed destinations lead; optional voucher details stay progressively disclosed.
// Mobile is one column, desktop uses the existing form/receipt rail. No invented activity.
export function programsScreen({wallet,connect,language,esc}) {
  const L=(key,args)=>translate(language(),key,args);
  const uiError=(key,args)=>Object.assign(new Error(L(key,args)),{localized:true});
  let root=null,epoch=0,busy=false,loading=false,list=null,selected=null,prepared=null,error='',errorDetails='',failedAction='',message='',controller=null;
  let amount='',voucherText='',pending=null,recovery=null;
  const storageKey='plugged.programTransaction';
  try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null');if(saved?.id){recovery=saved;pending=saved.txHash?saved:null;}}catch{}
  const persist=v=>{localStorage.setItem(storageKey,JSON.stringify(v));};
  const current=()=>list?.programs.find(p=>p.id===selected);
  const display=(value,p)=>`${formatUnits(BigInt(value),p.decimals)} ${p.symbol}`;
  const line=(label,value)=>`<div class="receipt-line"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  const btn=(action,label,primary=false)=>`<button type="button" ${primary?'class="primary"':''} data-program-action="${action}" ${busy?'disabled':''}>${esc(label)}</button>`;
  const phase=p=>({open:L('programs.contributionsOpen'),successful:L('programs.goalReachedPayoutReady'),failed:L('programs.goalMissedRefundsOpen'),paid:L('programs.beneficiaryPaid'),cashback:L('programs.separateCashbackBudget')})[p.phase];
  function reportError(e){
    const raw=e.shortMessage||e.message||String(e);
    const messages=[
      [/insufficient.*balance/i,'programs.insufficientBalanceFundWallet'],
      [/exceeds.*budget|remaining funded budget|partial claims|funding would exceed/i,'programs.amountExceedsAvailableCashback'],
      [/signature|signed attestor voucher|attestor.*not configured/i,'programs.validAttestorSignedVoucher'],
      [/voucher expired/i,'programs.voucherExpiredRequestFresh'],
      [/nothing.*claim|nothing left/i,'programs.voucherHasNoRemaining'],
      [/different wallet|voucher.*wallet/i,'programs.voucherBelongsAnotherWallet'],
      [/positive amount|precision|supported bounds/i,'programs.enterPositiveAmountWithin'],
      [/deadline|failed-goal refund|payout requires/i,'programs.campaignPhaseChangedRefresh'],
      [/bytecode|reorganized|manifest|deployment|transactions.*disabled/i,'programs.deploymentVerificationUnavailableRefresh'],
    ];
    const known=messages.find(([pattern])=>pattern.test(raw));
    error=e.localized?raw:known?L(known[1]):language()==='en'?raw:L('programs.requestFailedGeneric');
    errorDetails=error===raw?'':raw;
  }
  async function api(path,body) {
    const response=await fetch('/api/programs'+path,{...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||L('programs.requestFailedRefreshRetry'));return result;
  }
  function renderReceipt(){
    if(!root)return;const target=root.querySelector('[data-program-receipt]');if(!target)return;
    const p=current(),r=prepared;
    let html=`<h2 tabindex="-1">${L('programs.transactionReview')}</h2>`;
    if(r&&p){
      html+=line(L('programs.action'),r.next==='reset-approval'?L('programs.resetAllowanceZero'):r.next==='approve'?L('programs.approveExactAmount'):actionName(r.action));
      const a=r.expected.args;
      html+=line(L('programs.amount'),display(a.amount??a.value??'0',p));
      html+=`<p class="receipt-note">${L('programs.payingWallet')}</p><p class="address-block">${esc(r.account)}</p>`;
      const approval=r.next!=='send';
      const destination=approval?a.spender:r.action==='payout'?a.beneficiary:r.action==='refund'?a.contributor:r.action==='claim'?a.trader:p.address;
      const destinationLabel=approval?L('programs.allowanceSpender'):['contribute','fund'].includes(r.action)?L('programs.escrowContractReceivingFunds'):L('programs.fixedPaymentRecipient');
      html+=`<p class="receipt-note">${destinationLabel}</p><p class="address-block" data-program-destination>${esc(destination)}</p>`;
      if(r.accounting)html+=line(L('programs.eligiblePaidFees'),display(r.accounting.eligibleFees,p))+line(L('programs.remainingFundedBudget'),display(r.accounting.available,p));
      html+=`<p class="receipt-note">${L('programs.simulationPassedReviewExpires')}: ${esc(new Date(r.expiresAt).toLocaleTimeString(language()))}.</p>`;
      html+=btn('send',r.next==='send'?L('programs.signTransaction'):L('programs.signApproval'),true);
      html+=`<p class="receipt-note">${L('programs.approvalsSeparateAfterConfirmation')}</p>`;
    }else html+=`<p class="receipt-note">${L('programs.reviewActionCheckCurrent')}</p>`;
    if(pending){html+=`<p class="address-block">${esc(pending.txHash)}</p>`+btn('confirm',L('advancedLaunch.checkConfirmation'));}
    else if(recovery){html+=`<details class="funding-section"><summary>${L('programs.recoverSentTransaction')}</summary><label class="field">${L('advancedLaunch.transactionHashFromWallet')}<input name="recoveryHash" autocomplete="off" spellcheck="false" maxlength="66" placeholder="0x…"></label>${btn('recover',L('programs.verifyTransaction'))}<p class="receipt-note">${L('programs.ifWalletDidNot')}</p>${btn('clear-recovery',L('programs.walletDidNotSend'))}</details>`;}
    target.innerHTML=html;
    // No program selected and nothing in flight: an empty review card is just noise.
    target.hidden=!p&&!r&&!pending&&!recovery;
    const status=root.querySelector('[data-program-status]');status.textContent=error||message;status.className=error?'error-list':'receipt-note';
    root.querySelector('[data-program-error-details]').innerHTML=errorDetails?`<details><summary>${L('programs.technicalDetails')}</summary><p class="receipt-note">${esc(errorDetails)}</p></details>`:'';
    root.querySelectorAll('[data-program-form]').forEach(form=>{
      const field=form.querySelector('input,textarea'),id='program-error-'+form.dataset.programForm;
      let note=form.querySelector('[data-field-error]');if(!note){note=document.createElement('p');note.id=id;note.dataset.fieldError='';note.className='error-list';form.append(note);}
      const text=error&&failedAction===form.dataset.programForm?error:'';note.textContent=text;note.hidden=!text;
      if(field){field.setAttribute('aria-invalid',String(Boolean(text)));if(text)field.setAttribute('aria-describedby',id);else field.removeAttribute('aria-describedby');}
    });
    root.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=busy);
  }
  function actionName(action){return {contribute:L('programs.contribute'),refund:L('programs.refundMyContribution'),payout:L('programs.payFixedBeneficiary'),fund:L('programs.fundCashback'),claim:L('programs.claimCashback')}[action]||action;}
  function render(){
    if(!root)return;
    let html=`<div class="page-top"><div><h1>${L('programs.campaignsCashback')}</h1><p>${L('programs.trackContributionsFailedGoal')}</p></div>${btn('refresh',L('programs.refresh'))}</div>`;
    if(loading&&!list)html+=`<p role="status">${L('programs.checkingVerifiedDeployments')}</p>`;
    if(list&&!list.programs.length)html+=`<section class="form-section"><h2>${L('programs.noVerifiedProgramsAvailable')}</h2><p>${L('programs.noCampaignCashbackDeployment')}</p></section>`;
    if(list?.unavailable.length)html+=`<details class="form-section"><summary>${L('programs.deploymentChecksNeedAttention')}</summary>${list.unavailable.map(v=>`<p class="receipt-note">${esc(v.id)}: ${esc(v.reason)}</p>`).join('')}</details>`;
    const p=current();
    if(p){
      html+=`<label class="field">${L('programs.chooseProgram')}<select name="program">${list.programs.map(v=>`<option value="${esc(v.id)}" ${v.id===p.id?'selected':''}>${esc(v.name)} · ${v.kind==='campaign'?L('programs.campaign'):L('programs.cashbackKind')}</option>`).join('')}</select></label>`;
      html+=`<div class="form-layout"><div><section class="form-section"><h2>${esc(p.name)}</h2><p class="receipt-note">${esc(phase(p))}${p.localTest?' · '+L('programs.localTestOnlyNo'):''}</p><p class="address-block">${esc(p.address)}</p>`;
      html+=`<p class="receipt-note">${L('programs.currency')}: ${esc(p.symbol)} · ${esc(p.currency)}. ${L('programs.network')}: ${p.chainId}.</p>`;
      if(p.kind==='campaign'){
        html+=line(L('programs.recordedContributions'),display(p.totalContributed,p))+line(L('programs.goal'),display(p.goal,p));
        html+=line(L('programs.deadlineUtc'),new Date(Number(p.deadline)*1000).toISOString().replace('T',' ').replace('.000Z',' UTC'));
        html+=`<p class="receipt-note">${L('programs.fixedBeneficiary')}</p><p class="address-block">${esc(p.beneficiary)}</p>`;
        if(p.account)html+=line(L('programs.recordedContribution'),display(p.contribution,p))+line(L('programs.refundableAmount'),display(p.refundable,p));
        html+=`<p class="receipt-note">${L('programs.noPayoutBeforeDeadline')}</p>`;
      }else {
        html+=line(L('programs.rebateEligiblePaidFees'),`${Number(p.rebateBps)/100}%`)+line(L('programs.totalBudgetCap'),display(p.budget,p))+line(L('programs.actuallyFunded'),display(p.totalFunded,p))+line(L('programs.remainingFundedBudget'),display(p.available,p));
        if(p.account)html+=line(L('programs.claimedCashback'),display(p.claimed,p));
        html+=`<p class="receipt-note">${L('programs.attestor')}: ${esc(p.attestor)}.</p><p class="receipt-note">${L('programs.onlySignedCumulativeEligible')}</p>`;
        if(p.attestationStatus==='unconfigured')html+=`<p class="receipt-note">${L('programs.automaticCashbackAttestationsNot')}</p>`;
      }
      html+='</section>';
      if(!p.enabled)html+=`<p class="receipt-note">${L('programs.transactionsDisabledByOperator')}</p>`;
      else if(!wallet().account)html+=btn('connect',L('programs.connectWalletContinue'),true);
      else if(p.kind==='campaign'){
        if(p.phase==='open')html+=`<form data-program-form="contribute" class="form-section"><label class="field">${L('programs.contribution')} (${esc(p.symbol)})<input name="amount" inputmode="decimal" autocomplete="off" value="${esc(amount)}" maxlength="98" required></label><button class="primary" type="submit">${L('programs.reviewContribution')}</button></form>`;
        if(p.phase==='successful')html+=btn('payout',L('programs.reviewBeneficiaryPayout'),true);
        if(p.phase==='failed'&&BigInt(p.refundable)>0n)html+=btn('refund',L('programs.reviewMyRefund'),true);
      }else {
        html+=`<section class="form-section"><h2>${L('programs.claimCashback2')}</h2>`;
        if(p.attestationStatus==='configured')html+=btn('voucher',L('programs.fetchVerifiedVoucher'));
        html+=`<form data-program-form="claim"><label class="field">${L('programs.signedVoucherJson')}<textarea name="voucher" tabindex="0" spellcheck="false" autocomplete="off" maxlength="4096" required>${esc(voucherText)}</textarea></label><button type="submit" class="primary">${L('programs.verifyReviewCashback')}</button></form></section>`;
        if(BigInt(p.fundingRemaining)>0n)html+=`<details class="form-section funding-section"><summary>${L('programs.addSeparateCashbackFunding')}</summary><form data-program-form="fund"><label class="field">${L('programs.amount')} (${esc(p.symbol)})<input name="amount" inputmode="decimal" autocomplete="off" value="${esc(amount)}" maxlength="98" required></label><p class="receipt-note">${L('programs.maximumAdditionalFunding')}: ${esc(display(p.fundingRemaining,p))}.</p><button type="submit">${L('programs.reviewFunding')}</button></form></details>`;
      }
      html+='</div><aside class="plan-receipt rail-panel" data-program-receipt aria-label="'+L('programs.transactionReview')+'"></aside></div>';
    }else html+='<section class="form-section" data-program-receipt></section>';
    html+=`<p data-program-status role="status" aria-live="polite" tabindex="-1"></p><div data-program-error-details></div><p class="receipt-note">${L('programs.campaignEscrowCannotFund')}</p>`;
    root.innerHTML=html;renderReceipt();
  }
  async function load(terminal={}){
    const revision=++epoch;prepared=null;list=null;busy=false;loading=true;error='';errorDetails='';failedAction='';message='';
    try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null');recovery=saved?.id?saved:null;pending=recovery?.txHash?recovery:null;}catch{}
    render();
    try{const account=wallet().account;const result=await api(account?'?account='+encodeURIComponent(account):'');if(epoch!==revision||!root)return;list=result;if(!current())selected=list.programs[0]?.id??null;}
    catch(e){if(epoch===revision){reportError(e);list=null;}}
    finally{if(epoch===revision&&root){loading=false;if(!error){message=terminal.message||'';error=terminal.error||'';}render();}}
  }
  async function walletFor(account,chainId,revision){
    const w=wallet();if(!w.provider||w.account?.toLowerCase()!==account.toLowerCase()||epoch!==revision)throw uiError('advancedLaunch.walletChangedReviewAgain');
    const chain=await w.provider.request({method:'eth_chainId'});
    if(Number(chain)!==chainId)throw uiError('programs.switchWalletChainThen',{p0:chainId});
    const accounts=await w.provider.request({method:'eth_accounts'});
    if(accounts?.[0]?.toLowerCase()!==account.toLowerCase()||epoch!==revision||wallet().provider!==w.provider)throw uiError('advancedLaunch.walletChangedReviewAgain');
    return w.provider;
  }
  async function confirmed(result,revision){
    if(epoch!==revision||!root)return;
    if(result.status==='confirmed'||result.status==='reverted'){
      pending=null;recovery=null;localStorage.removeItem(storageKey);prepared=null;
      const terminal=result.status==='reverted'?{error:L('programs.transactionRevertedNoProgram')}:{message:L('programs.confirmedChainRefreshReview')};
      // load owns its new epoch; no old continuation may restore account-specific state.
      await load(terminal);
    }else message=L('programs.submittedCheckAgainAfter');
  }
  async function run(action){
    if(busy)return;
    if(action==='refresh')return load();
    if(action==='clear-recovery'&&!pending){recovery=null;localStorage.removeItem(storageKey);prepared=null;message='';error='';renderReceipt();return;}
    if(action==='connect'){const revision=epoch;try{await connect();if(epoch===revision&&root)await load();}catch(e){if(epoch===revision&&root){reportError(e);renderReceipt();}}return;}
    const revision=epoch,p=current();let recoveryHash=root?.querySelector('[name=recoveryHash]')?.value;
    busy=true;error='';errorDetails='';failedAction='';message=L('advancedLaunch.checking');renderReceipt();
    try{
      if(action==='confirm'||action==='recover'){
        const request=pending||{id:recovery?.id,txHash:recoveryHash};
        if(!request.id||!/^0x[\da-f]{64}$/i.test(request.txHash??''))throw uiError('programs.enterFullTransactionHash');
        const result=await api('/submit',{id:request.id,txHash:request.txHash});if(epoch!==revision||!root)return;pending=request;recovery=request;persist(request);await confirmed(result,revision);
      }else if(action==='send'){
        if(pending||recovery)throw uiError('programs.resolvePreviousWalletRequest');
        const r=prepared;if(!r)throw uiError('programs.reviewActionFirst');
        const provider=await walletFor(r.account,r.chainId,revision);
        if(Date.now()>=r.expiresAt)throw uiError('advancedLaunch.reviewExpiredReviewAgain');
        const recoveryRecord={id:r.id,programId:r.programId,chainId:r.chainId};recovery=recoveryRecord;persist(recoveryRecord);
        prepared=null;renderReceipt();
        const txHash=await provider.request({method:'eth_sendTransaction',params:[r.transaction]});
        const submitted={...recoveryRecord,txHash};
        // A wallet may broadcast after navigation/account change. Save its hash without
        // touching the new screen or overwriting a newer preparation's recovery record.
        if(JSON.parse(localStorage.getItem(storageKey)||'null')?.id===r.id)persist(submitted);
        if(epoch===revision&&root){pending=submitted;recovery=submitted;prepared=null;}
        const result=await api('/submit',{id:r.id,txHash});await confirmed(result,revision);
      }else {
        if(!p||!p.enabled)throw uiError('programs.noEnabledVerifiedProgram');
        if(pending||recovery)throw uiError('programs.resolvePreviousTransactionBefore');
        const account=wallet().account;if(!account){await connect();if(epoch===revision&&root)await load();return;}
        await walletFor(account,p.chainId,revision);
        if(action==='voucher'){
          const result=await api('/voucher',{programId:p.id,account});if(epoch!==revision)return;voucherText=JSON.stringify(result.voucher,null,2);message=L('programs.signedVoucherReceivedVerify');render();
        }else {
          const body={programId:p.id,account,action};if(action==='contribute'||action==='fund')body.amount=amount;
          if(action==='claim'){try{body.voucher=JSON.parse(voucherText);}catch{throw uiError('programs.pasteValidSignedVoucher');}}
          const result=await api('/prepare',body);if(epoch!==revision)return;prepared=result;message=L('programs.simulationPassedCheckTransaction');
        }
      }
    }catch(e){if(epoch===revision&&root){failedAction=action;if(e.code===4001){if(action==='send'&&!pending){recovery=null;localStorage.removeItem(storageKey);}error=L('programs.walletRequestRejectedReview');}else reportError(e);}}
    finally{
      if(epoch!==revision||!root)return;
      busy=false;renderReceipt();
      const form=error?root?.querySelector(`[data-program-form="${failedAction}"]`):null;
      const target=form?.querySelector('input,textarea')||(prepared?root?.querySelector('[data-program-receipt] h2'):root?.querySelector('[data-program-status]'));
      target?.focus({preventScroll:true});if(target&&(error||prepared))target.scrollIntoView({block:'center',behavior:'instant'});
    }
  }
  function mount(element){
    destroy();root=element;if(!root)throw new Error('programsScreen.mount requires a root element.');controller=new AbortController();
    root.addEventListener('click',e=>{const button=e.target.closest('[data-program-action]');if(button)void run(button.dataset.programAction);},{signal:controller.signal});
    root.addEventListener('submit',e=>{const form=e.target.closest('[data-program-form]');if(form){e.preventDefault();if(form.reportValidity())void run(form.dataset.programForm);}},{signal:controller.signal});
    root.addEventListener('input',e=>{if(e.target.name==='amount')amount=e.target.value;if(e.target.name==='voucher')voucherText=e.target.value;if(['amount','voucher'].includes(e.target.name)){epoch++;prepared=null;error='';message='';renderReceipt();}},{signal:controller.signal});
    root.addEventListener('change',e=>{if(e.target.name==='program'){selected=e.target.value;amount='';voucherText='';epoch++;prepared=null;error='';message='';render();}},{signal:controller.signal});
    return load();
  }
  function invalidate(){epoch++;prepared=null;list=null;busy=false;amount='';voucherText='';message='';error='';errorDetails='';failedAction='';if(root)return load();}
  function destroy(){epoch++;controller?.abort();controller=null;prepared=null;list=null;busy=false;loading=false;amount='';voucherText='';message='';error='';errorDetails='';failedAction='';root=null;}
  return {mount,invalidate,destroy};
}
