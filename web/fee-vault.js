import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { serverError } from './i18n.js';

// Reclaimable fee containers. Every amount shown is an on-chain vault read at one block;
// nothing is estimated. Undeployed or unverified vaults render an honest unavailable state.
export function feeVaultScreen({wallet,connect,language,esc}){
  const L=(en,es)=>language()==='es'?es:en;
  const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
  let root=null,epoch=0,busy=false,status=null,data=null,review=null,message='',error='',provider=null,extendDays=30;
  const requests=new Set();
  const stateLabel=s=>({pending:L('Waiting for response','Esperando respuesta'),accepted:L('Accepted','Aceptado'),declined:L('Declined','Rechazado'),reclaimed:L('Returned to allocator','Devuelto al asignador'),expired:L('Expired','Vencido')}[s]??s);
  const actionLabel=a=>({accept:L('Accept with this wallet','Aceptar con esta billetera'),decline:L('Decline','Rechazar'),claim:L('Claim','Cobrar'),reclaim:L('Reclaim to my wallet','Recuperar a mi billetera'),sweep:L('Collect inbox funds','Recoger fondos del buzón'),operatorReturn:L('Return to allocator','Devolver al asignador'),extend:L('Extend deadline','Extender plazo')}[a]);
  const amount=(n,decimals,symbol)=>{const [whole,fraction]=formatUnits(BigInt(n),decimals).split('.'),f=new Intl.NumberFormat(language()),point=f.formatToParts(1.1).find(p=>p.type==='decimal').value;return `${f.format(BigInt(whole))}${fraction?point+fraction:''} ${symbol}`;};
  const date=s=>new Intl.DateTimeFormat(language(),{dateStyle:'medium',timeStyle:'short'}).format(new Date(s*1000));
  const line=(label,value)=>`<div class="receipt-line"><span>${label}</span><strong>${esc(String(value))}</strong></div>`;
  const short=a=>a?`${a.slice(0,6)}…${a.slice(-4)}`:'';
  function watch(){const next=root?wallet().provider:null;if(provider===next)return;provider?.removeListener?.('accountsChanged',invalidate);provider?.removeListener?.('chainChanged',invalidate);provider=next;provider?.on?.('accountsChanged',invalidate);provider?.on?.('chainChanged',invalidate);}
  function invalidate(){epoch++;data=null;review=null;message=status?.deployed&&wallet().account?L('Wallet or settings changed. Refresh containers.','La billetera o los ajustes cambiaron. Actualiza los contenedores.'):'';error='';watch();render();}
  async function api(path,body){
    const controller=new AbortController();requests.add(controller);const timeout=setTimeout(()=>controller.abort(),60000);
    try{const r=await fetch(path,body===undefined?{signal:controller.signal}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});const result=await r.json();if(!r.ok)throw new Error(result.error?serverError(result.error,language()):L('Request failed. Retry.','Solicitud fallida. Reintenta.'));return result;}
    finally{clearTimeout(timeout);requests.delete(controller);}
  }
  async function bound(account,revision){
    const w=wallet();if(!root||epoch!==revision||!w.provider||!same(w.account,account))throw new Error(L('Wallet changed. Review again.','La billetera cambió. Revisa de nuevo.'));
    const [chain,accounts]=await Promise.all([w.provider.request({method:'eth_chainId'}),w.provider.request({method:'eth_accounts'})]);
    if(Number(chain)!==status.chainId)throw new Error(L(`Switch your wallet to chain ${status.chainId}, then refresh.`,`Cambia tu billetera a la cadena ${status.chainId} y actualiza.`));
    if(epoch!==revision||!same(accounts?.[0],account))throw new Error(L('Wallet changed. Review again.','La billetera cambió. Revisa de nuevo.'));
    return w.provider;
  }
  function card(c,role){
    const money=n=>amount(n,c.decimals,c.symbol),acts=Object.entries(c.actions).filter(([,ok])=>ok).map(([a])=>a);
    const held=BigInt(c.balance)+BigInt(c.inboxBalance);
    return `<article class="form-section" data-container="${esc(c.id)}"><h3>${L('Container','Contenedor')} #${esc(c.id)} · ${esc(stateLabel(c.state))}</h3>
      ${line(L('Held for this container','Retenido en este contenedor'),money(held))}
      ${BigInt(c.inboxBalance)>0n?line(L('Of which still in inbox','De lo cual aún en el buzón'),money(c.inboxBalance)):''}
      ${line(L('Paid out so far','Pagado hasta ahora'),money(c.paid))}
      ${line(role==='recipient'?L('From allocator','Del asignador'):L('Recipient wallet','Billetera destinataria'),short(role==='recipient'?c.allocator:c.recipient))}
      ${c.state==='pending'?line(L('Respond before','Responde antes de'),date(c.deadline)):line(L('Deadline','Plazo'),date(c.deadline))}
      ${c.operator?line(L('Operator (deadline / return only)','Operador (solo plazo / devolución)'),short(c.operator)):''}
      <p class="address-block">${L('Inbox','Buzón')}: ${esc(c.inbox)}</p>
      ${role==='recipient'&&c.state==='pending'?`<p class="receipt-note">${L('Accepting proves you control this exact wallet. Accrued and future fees become yours and can never be reclaimed.','Aceptar demuestra que controlas esta billetera exacta. Las comisiones acumuladas y futuras serán tuyas y nunca podrán recuperarse.')}</p>`:''}
      ${role==='allocator'&&c.state==='pending'?`<p class="receipt-note">${L('You can reclaim only if the recipient declines or the deadline passes.','Solo puedes recuperar si el destinatario rechaza o vence el plazo.')}</p>`:''}
      <div class="actions">${acts.map(a=>`<button type="button" data-vault="${a}" data-id="${esc(c.id)}" ${busy?'disabled':''}>${esc(actionLabel(a))}</button>`).join('')}</div></article>`;
  }
  function render(){
    if(!root)return;const account=wallet().account;let body;
    if(!status)body=`<p>${L('Checking fee vault…','Comprobando la bóveda de comisiones…')}</p>`;
    else if(!status.deployed)body=`<p>${L('Not deployed yet. No funds can be held, accepted or reclaimed here until a verified vault is configured. Nothing shown here is a balance.','Aún no desplegada. No se pueden retener, aceptar ni recuperar fondos hasta configurar una bóveda verificada. Nada aquí es un saldo.')}</p>`;
    else if(!account)body=`<p>${L('After you connect your wallet above, containers addressed to you or created by you appear here.','Cuando conectes tu billetera arriba, aquí aparecen los contenedores dirigidos a ti o creados por ti.')}</p>`;
    else{
      const current=data&&same(data.account,account)?data:null;
      body=`<p class="address-block">${L('Vault','Bóveda')}: ${esc(status.address)}</p><button type="button" data-vault="refresh" ${busy?'disabled':''}>${current?L('Refresh containers','Actualizar contenedores'):L('Load containers','Cargar contenedores')}</button>`;
      if(current){
        body+=`<h3>${L('Addressed to you','Dirigidos a ti')}</h3>${current.recipient.length?current.recipient.map(c=>card(c,'recipient')).join(''):`<p>${L('No containers for this wallet.','No hay contenedores para esta billetera.')}</p>`}`;
        body+=`<h3>${L('Created by you','Creados por ti')}</h3>${current.allocator.length?current.allocator.map(c=>card(c,'allocator')).join(''):`<p>${L('You have not allocated any containers.','No has asignado contenedores.')}</p>`}`;
        body+=`<p class="receipt-note">${L('Amounts read at block','Montos leídos en el bloque')} ${esc(current.blockNumber)}.</p>`;
      }
    }
    let receipt='';
    if(review){const e=review.expected;receipt=`<section class="form-section"><h3>${esc(actionLabel(review.action))} · #${esc(review.containerId)}</h3>${line(L('Signing wallet','Billetera firmante'),review.account)}${line(L('Contract','Contrato'),review.transaction.to)}
      ${BigInt(e.amount)>0n?line(L('Amount','Monto'),amount(e.amount,e.decimals,e.symbol)):''}${e.payee?line(L('Paid only to','Pagado solo a'),e.payee):''}
      ${review.notes.map(n=>`<p class="receipt-note">${esc(serverError(n,language()))}</p>`).join('')}
      <div class="actions"><button type="button" data-vault="sign" ${busy?'disabled':''}>${L('Sign in wallet','Firmar en billetera')}</button><button type="button" data-vault="cancel" ${busy?'disabled':''}>${L('Cancel','Cancelar')}</button></div></section>`;}
    const extend=data&&account?`<label class="receipt-note">${L('Extend by (days, max 365 from now)','Extender (días, máx. 365 desde hoy)')} <input type="number" min="1" max="365" inputmode="numeric" data-vault-days value="${extendDays}"></label>`:'';
    root.innerHTML=`<section class="form-section" aria-labelledby="fee-vault-title"><h2 id="fee-vault-title">${L('Reclaimable fee containers','Contenedores de comisiones recuperables')}</h2>
      <p>${L('Fees for an invited recipient wait here until they accept from their exact payout wallet. If they decline or never answer before the deadline, the creator can take them back.','Las comisiones de un destinatario invitado esperan aquí hasta que acepte desde su billetera exacta. Si rechaza o no responde antes del plazo, el creador puede recuperarlas.')}</p>
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
    if(action==='extend'){const days=Number(root.querySelector('[data-vault-days]')?.value);if(!Number.isInteger(days)||days<1||days>365)throw new Error(L('Enter 1 to 365 days.','Ingresa de 1 a 365 días.'));extendDays=days;body.deadline=Math.min(Math.max(c.deadline,data.blockTimestamp)+days*86400,data.blockTimestamp+365*86400-60);}
    const r=await api('/api/vault/prepare',body);if(revision!==epoch)throw new Error(L('Wallet changed. Review again.','La billetera cambió. Revisa de nuevo.'));review=r;
  }
  async function sign(){
    const r=review,revision=epoch,p=await bound(r.account,revision);
    if(Date.now()>r.expiresAt){review=null;throw new Error(L('Preparation expired. Prepare again.','La preparación venció. Prepara de nuevo.'));}
    const txHash=await p.request({method:'eth_sendTransaction',params:[r.transaction]});
    message=L('Submitted. Waiting for 3 confirmations…','Enviado. Esperando 3 confirmaciones…');review=null;render();
    for(let i=0;i<120&&root&&revision===epoch;i++){
      const s=await api('/api/vault/submit',{id:r.id,txHash,account:r.account,chainId:status.chainId});
      if(s.status==='confirmed'){message=L('Confirmed on-chain.','Confirmado en la cadena.');await load();return;}
      if(s.status==='reverted')throw new Error(L('Transaction reverted. Nothing moved.','La transacción revirtió. Nada se movió.'));
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
