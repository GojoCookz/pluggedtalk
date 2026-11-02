import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';

// Operate mode: extend Plugged's existing white/green receipt surface and system type.
// Funds and fixed destinations lead; optional voucher details stay progressively disclosed.
// Mobile is one column, desktop uses the existing form/receipt rail. No invented activity.
export function programsScreen({wallet,connect,language,esc}) {
  const L=(en,es)=>language()==='es'?es:en;
  const uiError=(en,es)=>Object.assign(new Error(L(en,es)),{localized:true});
  let root=null,epoch=0,busy=false,loading=false,list=null,selected=null,prepared=null,error='',errorDetails='',failedAction='',message='',controller=null;
  let amount='',voucherText='',pending=null,recovery=null;
  const storageKey='plugged.programTransaction';
  try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null');if(saved?.id){recovery=saved;pending=saved.txHash?saved:null;}}catch{}
  const persist=v=>{localStorage.setItem(storageKey,JSON.stringify(v));};
  const current=()=>list?.programs.find(p=>p.id===selected);
  const display=(value,p)=>`${formatUnits(BigInt(value),p.decimals)} ${p.symbol}`;
  const line=(label,value)=>`<div class="receipt-line"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;
  const btn=(action,label,primary=false)=>`<button type="button" ${primary?'class="primary"':''} data-program-action="${action}" ${busy?'disabled':''}>${esc(label)}</button>`;
  const phase=p=>({open:L('Contributions open','Aportes abiertos'),successful:L('Goal reached · payout ready','Meta alcanzada · pago disponible'),failed:L('Goal missed · refunds open','Meta no alcanzada · reembolsos abiertos'),paid:L('Beneficiary paid','Beneficiario pagado'),cashback:L('Separate cashback budget','Presupuesto de cashback independiente')})[p.phase];
  function reportError(e){
    const raw=e.shortMessage||e.message||String(e);
    const messages=[
      [/insufficient.*balance/i,'Insufficient balance. Fund this wallet, then review again.','Saldo insuficiente. Añade fondos a esta billetera y revisa de nuevo.'],
      [/exceeds.*budget|remaining funded budget|partial claims|funding would exceed/i,'The amount exceeds available cashback funds. Refresh and check the budget.','El importe supera los fondos de cashback disponibles. Actualiza y comprueba el presupuesto.'],
      [/signature|signed attestor voucher|attestor.*not configured/i,'A valid attestor-signed voucher is required. Check the signer configuration or import a valid voucher.','Se requiere un comprobante firmado válido. Comprueba la configuración del firmante o importa un comprobante válido.'],
      [/voucher expired/i,'This voucher expired. Request a fresh signed voucher.','Este comprobante venció. Solicita un comprobante firmado nuevo.'],
      [/nothing.*claim|nothing left/i,'This voucher has no remaining cashback. Request a newer voucher after eligible trades.','Este comprobante no tiene cashback pendiente. Solicita uno nuevo tras operaciones elegibles.'],
      [/different wallet|voucher.*wallet/i,'This voucher belongs to another wallet. Connect its recipient wallet.','Este comprobante pertenece a otra billetera. Conecta la billetera destinataria.'],
      [/positive amount|precision|supported bounds/i,'Enter a positive amount within this currency’s decimal precision.','Introduce un importe positivo con la precisión decimal de esta moneda.'],
      [/deadline|failed-goal refund|payout requires/i,'The campaign phase changed. Refresh to see available contributions, payouts or refunds.','La fase de la campaña cambió. Actualiza para ver aportes, pagos o reembolsos disponibles.'],
      [/bytecode|reorganized|manifest|deployment|transactions.*disabled/i,'Deployment verification is unavailable. Refresh or ask the operator to verify the program.','La verificación del contrato no está disponible. Actualiza o pide al operador que verifique el programa.'],
    ];
    const known=messages.find(([pattern])=>pattern.test(raw));
    error=e.localized?raw:known?L(known[1],known[2]):language()==='es'?'No se pudo completar la solicitud. Comprueba la red, actualiza los saldos y reintenta.':raw;
    errorDetails=error===raw?'':raw;
  }
  async function api(path,body) {
    const response=await fetch('/api/programs'+path,{...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||L('Request failed. Refresh and retry.','La solicitud falló. Actualiza y reintenta.'));return result;
  }
  function renderReceipt(){
    if(!root)return;const target=root.querySelector('[data-program-receipt]');if(!target)return;
    const p=current(),r=prepared;
    let html=`<h2 tabindex="-1">${L('Transaction review','Revisión de la transacción')}</h2>`;
    if(r&&p){
      html+=line(L('Action','Acción'),r.next==='reset-approval'?L('Reset allowance to zero','Restablecer permiso a cero'):r.next==='approve'?L('Approve exact amount','Aprobar importe exacto'):actionName(r.action));
      const a=r.expected.args;
      html+=line(L('Amount','Importe'),display(a.amount??a.value??'0',p));
      html+=`<p class="receipt-note">${L('Paying wallet','Billetera que firma')}</p><p class="address-block">${esc(r.account)}</p>`;
      const approval=r.next!=='send';
      const destination=approval?a.spender:r.action==='payout'?a.beneficiary:r.action==='refund'?a.contributor:r.action==='claim'?a.trader:p.address;
      const destinationLabel=approval?L('Allowance spender','Receptor del permiso'):['contribute','fund'].includes(r.action)?L('Escrow contract receiving funds','Contrato que recibe los fondos'):L('Fixed payment recipient','Destinatario fijo del pago');
      html+=`<p class="receipt-note">${destinationLabel}</p><p class="address-block" data-program-destination>${esc(destination)}</p>`;
      if(r.accounting)html+=line(L('Eligible paid fees','Comisiones pagadas elegibles'),display(r.accounting.eligibleFees,p))+line(L('Remaining funded budget','Fondos disponibles'),display(r.accounting.available,p));
      html+=`<p class="receipt-note">${L('Simulation passed. Review expires','Simulación correcta. La revisión vence')}: ${esc(new Date(r.expiresAt).toLocaleTimeString(language()))}.</p>`;
      html+=btn('send',r.next==='send'?L('Sign transaction','Firmar transacción'):L('Sign approval','Firmar permiso'),true);
      html+=`<p class="receipt-note">${L('Approvals are separate. After confirmation, review again. An expired review does not cancel signed calldata.','Los permisos son independientes. Tras confirmar, revisa de nuevo. Una revisión vencida no cancela los datos firmados.')}</p>`;
    }else html+=`<p class="receipt-note">${L('Review an action to check current balances and simulate it before your wallet signs.','Revisa una acción para comprobar saldos y simularla antes de firmar.')}</p>`;
    if(pending){html+=`<p class="address-block">${esc(pending.txHash)}</p>`+btn('confirm',L('Check confirmation','Comprobar confirmación'));}
    else if(recovery){html+=`<details class="funding-section"><summary>${L('Recover a sent transaction','Recuperar una transacción enviada')}</summary><label class="field">${L('Transaction hash from your wallet','Hash de tu billetera')}<input name="recoveryHash" autocomplete="off" spellcheck="false" maxlength="66" placeholder="0x…"></label>${btn('recover',L('Verify transaction','Verificar transacción'))}<p class="receipt-note">${L('If your wallet did not send anything, clear this review to start again. Clearing never cancels an on-chain transaction.','Si tu billetera no envió nada, borra la revisión para empezar de nuevo. Borrarla no cancela una transacción en la cadena.')}</p>${btn('clear-recovery',L('Wallet did not send: clear review','No se envió: borrar revisión'))}</details>`;}
    target.innerHTML=html;
    const status=root.querySelector('[data-program-status]');status.textContent=error||message;status.className=error?'error-list':'receipt-note';
    root.querySelector('[data-program-error-details]').innerHTML=errorDetails?`<details><summary>${L('Technical details','Detalles técnicos')}</summary><p class="receipt-note">${esc(errorDetails)}</p></details>`:'';
    root.querySelectorAll('[data-program-form]').forEach(form=>{
      const field=form.querySelector('input,textarea'),id='program-error-'+form.dataset.programForm;
      let note=form.querySelector('[data-field-error]');if(!note){note=document.createElement('p');note.id=id;note.dataset.fieldError='';note.className='error-list';form.append(note);}
      const text=error&&failedAction===form.dataset.programForm?error:'';note.textContent=text;note.hidden=!text;
      if(field){field.setAttribute('aria-invalid',String(Boolean(text)));if(text)field.setAttribute('aria-describedby',id);else field.removeAttribute('aria-describedby');}
    });
    root.querySelectorAll('button,input,select,textarea').forEach(el=>el.disabled=busy);
  }
  function actionName(action){return {contribute:L('Contribute','Aportar'),refund:L('Refund my contribution','Reembolsar mi aporte'),payout:L('Pay fixed beneficiary','Pagar al beneficiario fijo'),fund:L('Fund cashback','Financiar cashback'),claim:L('Claim cashback','Cobrar cashback')}[action]||action;}
  function render(){
    if(!root)return;
    let html=`<div class="page-top"><div><h1>${L('Campaigns & cashback','Campañas y cashback')}</h1><p>${L('Track contributions, failed-goal refunds and separately funded fee rebates.','Consulta aportes, reembolsos por metas fallidas y cashback con fondos independientes.')}</p></div>${btn('refresh',L('Refresh','Actualizar'))}</div>`;
    if(loading&&!list)html+=`<p role="status">${L('Checking verified deployments…','Comprobando contratos verificados…')}</p>`;
    if(list&&!list.programs.length)html+=`<section class="form-section"><h2>${L('No verified programs available','No hay programas verificados disponibles')}</h2><p>${L('No campaign or cashback deployment is live in this configuration. Contributions and claims stay disabled until a deployment is verified.','Esta configuración no tiene campañas ni cashback desplegados y verificados. Los aportes y cobros siguen deshabilitados hasta verificar el contrato.')}</p></section>`;
    if(list?.unavailable.length)html+=`<details class="form-section"><summary>${L('Deployment checks need attention','Hay verificaciones pendientes')}</summary>${list.unavailable.map(v=>`<p class="receipt-note">${esc(v.id)}: ${esc(v.reason)}</p>`).join('')}</details>`;
    const p=current();
    if(p){
      html+=`<label class="field">${L('Choose a program','Elige un programa')}<select name="program">${list.programs.map(v=>`<option value="${esc(v.id)}" ${v.id===p.id?'selected':''}>${esc(v.name)} · ${v.kind==='campaign'?L('Campaign','Campaña'):'Cashback'}</option>`).join('')}</select></label>`;
      html+=`<div class="form-layout"><div><section class="form-section"><h2>${esc(p.name)}</h2><p class="receipt-note">${esc(phase(p))}${p.localTest?' · '+L('LOCAL TEST ONLY — no production funds','SOLO PRUEBA LOCAL — sin fondos de producción'):''}</p><p class="address-block">${esc(p.address)}</p>`;
      html+=`<p class="receipt-note">${L('Currency','Moneda')}: ${esc(p.symbol)} · ${esc(p.currency)}. ${L('Network','Red')}: ${p.chainId}.</p>`;
      if(p.kind==='campaign'){
        html+=line(L('Recorded contributions','Aportes registrados'),display(p.totalContributed,p))+line(L('Goal','Meta'),display(p.goal,p));
        html+=line(L('Deadline (UTC)','Fecha límite (UTC)'),new Date(Number(p.deadline)*1000).toISOString().replace('T',' ').replace('.000Z',' UTC'));
        html+=`<p class="receipt-note">${L('Fixed beneficiary','Beneficiario fijo')}</p><p class="address-block">${esc(p.beneficiary)}</p>`;
        if(p.account)html+=line(L('Your recorded contribution','Tu aporte registrado'),display(p.contribution,p))+line(L('Your refundable amount','Tu importe reembolsable'),display(p.refundable,p));
        html+=`<p class="receipt-note">${L('No payout before the deadline. A reached goal pays the fixed beneficiary; a missed goal refunds original contributors. This is not a refund of trading losses.','Sin pagos antes de la fecha límite. Si se alcanza la meta, cobra el beneficiario fijo; si no, se reembolsa a los aportantes originales. No cubre pérdidas al operar.')}</p>`;
      }else {
        html+=line(L('Rebate on eligible paid fees','Rebate sobre comisiones pagadas elegibles'),`${Number(p.rebateBps)/100}%`)+line(L('Total budget cap','Límite del presupuesto'),display(p.budget,p))+line(L('Actually funded','Fondos depositados'),display(p.totalFunded,p))+line(L('Remaining funded budget','Fondos disponibles'),display(p.available,p));
        if(p.account)html+=line(L('Your claimed cashback','Tu cashback cobrado'),display(p.claimed,p));
        html+=`<p class="receipt-note">${L('Attestor','Firmante autorizado')}: ${esc(p.attestor)}.</p><p class="receipt-note">${L('Only signed cumulative eligible-fee vouchers can be claimed. Claims exceeding available funds cannot be partially paid. Funding has no admin withdrawal. A compromised attestor can allocate the entire funded budget.','Solo se pueden cobrar comprobantes firmados de comisiones elegibles acumuladas. Si superan los fondos disponibles, no hay pago parcial. Los fondos no tienen retiro administrativo. Un firmante comprometido puede asignar todo el presupuesto.')}</p>`;
        if(p.attestationStatus==='unconfigured')html+=`<p class="receipt-note">${L('Automatic cashback attestations are not configured. A valid signed voucher can still be verified below.','La emisión automática de comprobantes no está configurada. Puedes verificar un comprobante firmado válido a continuación.')}</p>`;
      }
      html+='</section>';
      if(!p.enabled)html+=`<p class="receipt-note">${L('Transactions are disabled by the operator.','El operador ha deshabilitado las transacciones.')}</p>`;
      else if(!wallet().account)html+=btn('connect',L('Connect wallet to continue','Conectar billetera para continuar'),true);
      else if(p.kind==='campaign'){
        if(p.phase==='open')html+=`<form data-program-form="contribute" class="form-section"><label class="field">${L('Contribution','Aporte')} (${esc(p.symbol)})<input name="amount" inputmode="decimal" autocomplete="off" value="${esc(amount)}" maxlength="98" required></label><button class="primary" type="submit">${L('Review contribution','Revisar aporte')}</button></form>`;
        if(p.phase==='successful')html+=btn('payout',L('Review beneficiary payout','Revisar pago al beneficiario'),true);
        if(p.phase==='failed'&&BigInt(p.refundable)>0n)html+=btn('refund',L('Review my refund','Revisar mi reembolso'),true);
      }else {
        html+=`<section class="form-section"><h2>${L('Claim your cashback','Cobra tu cashback')}</h2>`;
        if(p.attestationStatus==='configured')html+=btn('voucher',L('Fetch verified voucher','Obtener comprobante verificado'));
        html+=`<form data-program-form="claim"><label class="field">${L('Signed voucher (JSON)','Comprobante firmado (JSON)')}<textarea name="voucher" tabindex="0" spellcheck="false" autocomplete="off" maxlength="4096" required>${esc(voucherText)}</textarea></label><button type="submit" class="primary">${L('Verify & review cashback','Verificar y revisar cashback')}</button></form></section>`;
        if(BigInt(p.fundingRemaining)>0n)html+=`<details class="form-section funding-section"><summary>${L('Add separate cashback funding','Añadir fondos independientes')}</summary><form data-program-form="fund"><label class="field">${L('Amount','Importe')} (${esc(p.symbol)})<input name="amount" inputmode="decimal" autocomplete="off" value="${esc(amount)}" maxlength="98" required></label><p class="receipt-note">${L('Maximum additional funding','Máximo aporte adicional')}: ${esc(display(p.fundingRemaining,p))}.</p><button type="submit">${L('Review funding','Revisar fondos')}</button></form></details>`;
      }
      html+='</div><aside class="plan-receipt rail-panel" data-program-receipt aria-label="'+L('Transaction review','Revisión de la transacción')+'"></aside></div>';
    }else html+='<section class="form-section" data-program-receipt></section>';
    html+=`<p data-program-status role="status" aria-live="polite" tabindex="-1"></p><div data-program-error-details></div><p class="receipt-note">${L('Campaign escrow cannot fund cashback. A fixed beneficiary is not verified charity identity, endorsement or tax deductibility.','El dinero de campañas no financia cashback. Un beneficiario fijo no verifica identidad benéfica, respaldo ni deducciones fiscales.')}</p>`;
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
    const w=wallet();if(!w.provider||w.account?.toLowerCase()!==account.toLowerCase()||epoch!==revision)throw uiError('Wallet changed. Review again.','La billetera cambió. Revisa de nuevo.');
    const chain=await w.provider.request({method:'eth_chainId'});
    if(Number(chain)!==chainId)throw uiError(`Switch your wallet to chain ${chainId}, then review again.`,`Cambia tu billetera a la red ${chainId} y revisa de nuevo.`);
    const accounts=await w.provider.request({method:'eth_accounts'});
    if(accounts?.[0]?.toLowerCase()!==account.toLowerCase()||epoch!==revision||wallet().provider!==w.provider)throw uiError('Wallet changed. Review again.','La billetera cambió. Revisa de nuevo.');
    return w.provider;
  }
  async function confirmed(result,revision){
    if(epoch!==revision||!root)return;
    if(result.status==='confirmed'||result.status==='reverted'){
      pending=null;recovery=null;localStorage.removeItem(storageKey);prepared=null;
      const terminal=result.status==='reverted'?{error:L('Transaction reverted. No program payment was confirmed. Review again.','La transacción revirtió. No se confirmó el pago. Revisa de nuevo.')}:{message:L('Confirmed on-chain. Refresh to review the next action.','Confirmado en la cadena. Actualiza para revisar la siguiente acción.')};
      // load owns its new epoch; no old continuation may restore account-specific state.
      await load(terminal);
    }else message=L('Submitted. Check again after two additional blocks.','Enviada. Comprueba de nuevo tras dos bloques adicionales.');
  }
  async function run(action){
    if(busy)return;
    if(action==='refresh')return load();
    if(action==='clear-recovery'&&!pending){recovery=null;localStorage.removeItem(storageKey);prepared=null;message='';error='';renderReceipt();return;}
    if(action==='connect'){const revision=epoch;try{await connect();if(epoch===revision&&root)await load();}catch(e){if(epoch===revision&&root){reportError(e);renderReceipt();}}return;}
    const revision=epoch,p=current();let recoveryHash=root?.querySelector('[name=recoveryHash]')?.value;
    busy=true;error='';errorDetails='';failedAction='';message=L('Checking…','Comprobando…');renderReceipt();
    try{
      if(action==='confirm'||action==='recover'){
        const request=pending||{id:recovery?.id,txHash:recoveryHash};
        if(!request.id||!/^0x[\da-f]{64}$/i.test(request.txHash??''))throw uiError('Enter the full transaction hash.','Introduce el hash completo.');
        const result=await api('/submit',{id:request.id,txHash:request.txHash});if(epoch!==revision||!root)return;pending=request;recovery=request;persist(request);await confirmed(result,revision);
      }else if(action==='send'){
        if(pending||recovery)throw uiError('Resolve the previous wallet request through recovery before signing again.','Resuelve la solicitud anterior mediante recuperación antes de volver a firmar.');
        const r=prepared;if(!r)throw uiError('Review the action first.','Revisa la acción primero.');
        const provider=await walletFor(r.account,r.chainId,revision);
        if(Date.now()>=r.expiresAt)throw uiError('Review expired. Review again before signing.','La revisión venció. Revisa antes de firmar.');
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
        if(!p||!p.enabled)throw uiError('No enabled verified program.','No hay un programa verificado habilitado.');
        if(pending||recovery)throw uiError('Resolve the previous transaction before preparing another. Use recovery if your wallet sent it.','Resuelve la transacción anterior antes de preparar otra. Usa recuperación si tu billetera la envió.');
        const account=wallet().account;if(!account){await connect();if(epoch===revision&&root)await load();return;}
        await walletFor(account,p.chainId,revision);
        if(action==='voucher'){
          const result=await api('/voucher',{programId:p.id,account});if(epoch!==revision)return;voucherText=JSON.stringify(result.voucher,null,2);message=L('Signed voucher received. Verify and review before claiming.','Comprobante firmado recibido. Verifica y revisa antes de cobrar.');render();
        }else {
          const body={programId:p.id,account,action};if(action==='contribute'||action==='fund')body.amount=amount;
          if(action==='claim'){try{body.voucher=JSON.parse(voucherText);}catch{throw uiError('Paste a valid signed voucher JSON object.','Pega un objeto JSON de comprobante firmado válido.');}}
          const result=await api('/prepare',body);if(epoch!==revision)return;prepared=result;message=L('Simulation passed. Check the transaction review before signing.','Simulación correcta. Revisa los datos antes de firmar.');
        }
      }
    }catch(e){if(epoch===revision&&root){failedAction=action;if(e.code===4001){if(action==='send'&&!pending){recovery=null;localStorage.removeItem(storageKey);}error=L('Wallet request rejected. Review again before signing.','Solicitud rechazada. Revisa de nuevo antes de firmar.');}else reportError(e);}}
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
