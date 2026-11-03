import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { NETWORK } from '../lib/config.mjs';

// Operate mode. Inherit Plugged's native system type and white/green tokens.
// The receipt separates unswept pool funds from personal claims and fixed destinations.
export function rewardsScreen({wallet,connect,language,esc}){
  const L=(en,es)=>language()==='es'?es:en;
  const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
  let root=null,epoch=0,busy=false,data=null,review=null,message='',error='',social=null,provider=null,socialDraft={kind:'github',username:''};
  const requests=new Set();
  const storageKey=account=>`plugged.rewards.pending.${account?.toLowerCase()}`;
  function saved(account=wallet().account){try{return JSON.parse(localStorage.getItem(storageKey(account))||'null');}catch{return null;}}
  function persist(value,account){localStorage.setItem(storageKey(account),JSON.stringify(value));}
  const amount=(n,decimals,symbol)=>{const [whole,fraction]=formatUnits(BigInt(n),decimals).split('.'),formatter=new Intl.NumberFormat(language()),point=formatter.formatToParts(1.1).find(p=>p.type==='decimal').value;return `${formatter.format(BigInt(whole))}${fraction?point+fraction:''} ${symbol}`;};
  const line=(label,value)=>`<div class="receipt-line"><span>${label}</span><strong>${esc(String(value))}</strong></div>`;
  const btn=(action,label,attrs='')=>`<button type="button" data-reward="${action}" ${busy?'disabled':''} ${attrs}>${label}</button>`;
  const actionLabel=a=>({sweep:L('Sweep pool fees','Distribuir comisiones del fondo'),holder:L('Claim holder rewards','Cobrar recompensas de titular'),creator:L('Sweep creator fees','Distribuir comisiones del creador'),splitter:L('Pay fixed recipient','Pagar al destinatario fijo')}[a]);
  const isSweep=a=>['sweep','creator'].includes(a);
  function watch(){
    // Parent invalidates every screen, including inactive routes. An inactive screen
    // must not subscribe again after destroy(); mount is the subscription boundary.
    const next=root?wallet().provider:null;if(provider===next)return;
    provider?.removeListener?.('accountsChanged',invalidate);provider?.removeListener?.('chainChanged',invalidate);provider=next;
    provider?.on?.('accountsChanged',invalidate);provider?.on?.('chainChanged',invalidate);
  }
  function invalidate(){epoch++;data=null;review=null;social=null;message=wallet().account?L('Wallet or settings changed. Refresh balances.','La billetera o los ajustes cambiaron. Actualiza los saldos.'):'';error='';watch();render();}
  async function api(path,body){
    const controller=new AbortController();requests.add(controller);const timeout=setTimeout(()=>controller.abort(),60000);
    try{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});const result=await r.json();if(!r.ok)throw new Error(result.error||L('Request failed. Retry.','Solicitud fallida. Reintenta.'));return result;}
    finally{clearTimeout(timeout);requests.delete(controller);}
  }
  async function bound(account,revision){
    const w=wallet();if(!root||epoch!==revision||!w.provider||!same(w.account,account))throw new Error(L('Wallet changed. Review again.','La billetera cambió. Revisa de nuevo.'));
    const [chain,accounts]=await Promise.all([w.provider.request({method:'eth_chainId'}),w.provider.request({method:'eth_accounts'})]);
    if(Number(chain)!==4663)throw new Error(L('Switch your wallet to Robinhood Chain (4663), then refresh.','Cambia tu billetera a Robinhood Chain (4663) y actualiza.'));
    if(epoch!==revision||wallet().provider!==w.provider||!same(wallet().account,account)||!same(accounts?.[0],account))throw new Error(L('Wallet changed. Review again.','La billetera cambió. Revisa de nuevo.'));
    return w.provider;
  }
  function render(){
    if(!root)return;const account=wallet().account,pending=saved(account),current=data&&same(data.account,account)?data:null;
    root.innerHTML=`<div id="rewards-screen">
      <div class="page-top"><div><h1>${L('Your rewards','Tus recompensas')}</h1><p>${L('Fees go to their configured recipients. Your wallet signs every transaction.','Las comisiones van a sus destinatarios configurados. Tu billetera firma cada transacción.')}</p></div></div>
      <div class="form-actions">${btn(account?'refresh':'connect',account?L('Refresh balances','Actualizar saldos'):L('Connect wallet','Conectar billetera'),'class="primary"')}</div>
      ${account?`<p class="address-block"><span class="sr-only">${L('Connected wallet','Billetera conectada')}: </span>${esc(account)}</p>`:`<p class="receipt-note">${L('Connect your wallet to see what you can collect.','Conecta tu billetera para ver lo que puedes cobrar.')}</p>`}
      <p id="rewards-status" role="status" aria-live="polite" class="${error?'error-list':'receipt-note'}">${esc(error||message)}</p>
      <div class="form-layout"><div id="reward-positions"></div><section class="plan-receipt rail-panel" aria-label="${L('Reward review','Revisión de recompensas')}" id="reward-review"></section></div>
      <section class="form-section"><h2>${L('Social beneficiaries','Beneficiarios sociales')}</h2><p class="receipt-note">${L('Resolve an X or GitHub profile to its EVM payout address. This may create an embedded wallet; it does not grant access to it.','Resuelve un perfil de X o GitHub a su dirección EVM. Esto puede crear una billetera integrada; no concede acceso a ella.')}</p>
      <form id="rewards-social"><div class="fields"><label class="field">${L('Provider','Proveedor')}<select name="kind" ${busy?'disabled':''}><option value="github" ${socialDraft.kind==='github'?'selected':''}>GitHub</option><option value="x" ${socialDraft.kind==='x'?'selected':''}>X</option></select></label><label class="field">${L('Profile username','Nombre del perfil')}<input name="username" required maxlength="100" autocomplete="off" spellcheck="false" placeholder="@username…" value="${esc(socialDraft.username)}" ${busy?'disabled':''}></label></div><button type="submit" ${busy?'disabled':''}>${L('Resolve payout address','Resolver dirección de pago')}</button></form>
      <div id="reward-social-result"></div><p class="receipt-note">${L('No OAuth or social login is available here. The recipient must obtain control of the exact resolved wallet through the provider. A profile match is not proof of wallet control, nonprofit status or endorsement.','Aquí no hay OAuth ni inicio de sesión social. El destinatario debe obtener control de la billetera exacta mediante el proveedor. Resolver un perfil no prueba control, condición de entidad benéfica ni respaldo.')}</p>
      <a class="text-link" href="https://docs.bags.fm/api-reference/get-fee-share-wallet" target="_blank" rel="noopener noreferrer">${L('Provider documentation','Documentación del proveedor')}</a></section></div>`;
    const positions=root.querySelector('#reward-positions');
    if(!current)positions.innerHTML=`<section class="form-section"><h2>${L('Confirmed Plugged launches','Lanzamientos Plugged confirmados')}</h2><p>${busy?L('Reading on-chain balances…','Consultando saldos en cadena…'):account?L('Choose Refresh balances to load your on-chain balances.','Elige Actualizar saldos para cargar tus saldos en cadena.'):L('Your launches and earnings appear here after you connect.','Tus lanzamientos e ingresos aparecen aquí al conectar.')}</p></section>`;
    else{
      positions.innerHTML=current.positions.length?current.positions.map(p=>{
        if(p.status==='unavailable')return `<section class="form-section"><h2>${esc(p.name)}</h2><p class="error-list">${esc(p.error)}</p></section>`;
        return `<section class="form-section"><h2>${esc(p.name)} · ${esc(p.symbol)}</h2><p class="address-block">${esc(p.token)}</p>${line(L('Holder claimable now','Disponible para el titular'),amount(p.holderClaimable,p.decimals,p.quoteSymbol))}${line(L('Holder paid to date (quote units)','Pagado al titular (unidades del par)'),amount(p.holderReceived,p.decimals,p.quoteSymbol))}${line(L('Unswept pool fees','Comisiones del fondo sin distribuir'),amount(p.pendingQuote,p.decimals,p.quoteSymbol))}${line(L('Unswept sell fees (launch token)','Comisiones de venta (token lanzado)'),amount(p.pendingToken,18,p.symbol))}<p class="receipt-note">${L('Pool fees are not your personal balance. Sweeping pays the configured creator and funds holder rewards; holder claims vest over time. Creator fees have no separate claim balance. This deployed hook cannot recover failed creator transfers. Holder amounts are quote accounting units; any reward conversion is recorded in the receipt.','Las comisiones del fondo no son tu saldo personal. Distribuir paga al creador y financia recompensas de titulares, que se liberan con el tiempo. El creador no tiene un saldo de cobro separado. Este contrato no recupera transferencias fallidas al creador. Los importes del titular son unidades contables del par; el recibo registra las conversiones.')}</p>${line(L('Creator fee wallet','Billetera del creador'),p.creator)}<div class="form-actions">${['holder',p.actions.creator?'creator':'sweep'].map(a=>p.actions[a]?btn('prepare',actionLabel(a),`data-action="${a}" data-token="${esc(p.token)}"`):'').join('')}</div></section>`;
      }).join(''):`<section class="form-section"><h2>${L('No Plugged rewards yet','Aún no hay recompensas Plugged')}</h2><p>${L('No confirmed Plugged launches were found. Unrelated Carbon launches are not imported.','No se encontraron lanzamientos Plugged confirmados. No se importan lanzamientos ajenos de Carbon.')}</p><a class="text-link" href="#create">${L('Create a coin','Crear una moneda')}</a></section>`;
      if(current.truncated)positions.innerHTML+=`<p class="receipt-note">${L('Showing the latest 100 launches.','Mostrando los últimos 100 lanzamientos.')}</p>`;
      positions.innerHTML+=`<section class="form-section"><h2>${L('Fixed-recipient splits','Repartos con destinatarios fijos')}</h2>${current.splitters.status==='unconfigured'?`<p>${L('Unconfigured. No verified Plugged splitter deployment is connected.','Sin configurar. No hay un contrato de reparto Plugged verificado conectado.')}</p>`:current.splitters.deployments.map(s=>s.status!=='verified'?`<p class="error-list">${esc(s.error)}</p>`:`<p class="address-block">${esc(s.address)}</p>${s.recipients.map(r=>`<div class="recipient-entry">${line(L('Fixed destination','Destino fijo'),r.address)}${line(L('Claimable','Disponible'),amount(r.claimable,s.decimals,s.symbol))}<p class="receipt-note">${L('Anyone can pay gas; funds only go to this address.','Cualquiera puede pagar el gas; los fondos solo van a esta dirección.')}</p>${BigInt(r.claimable)>0n?btn('prepare',actionLabel('splitter'),`data-action="splitter" data-splitter="${esc(s.address)}" data-recipient="${esc(r.address)}"`):''}</div>`).join('')}`).join('')}</section>`;
      if(!current.social.resolverConfigured)root.querySelector('#reward-social-result').innerHTML=`<p class="error-list">${L('Resolution blocked: server BAGS_API_KEY is missing. Use a wallet whose owner can verify control.','Resolución bloqueada: falta BAGS_API_KEY en el servidor. Usa una billetera cuyo titular pueda verificar el control.')}</p>`;
    }
    let receipt=`<h2>${L('Review before signing','Revisa antes de firmar')}</h2><p class="receipt-note">${L('Choose an available action. Nothing is signed automatically. ETH is required for gas.','Elige una acción disponible. Nada se firma automáticamente. Necesitas ETH para gas.')}</p>`;
    if(review){const r=review,e=r.expected;receipt=`<h2>${actionLabel(r.action)}</h2>${line(L('Signing wallet','Billetera firmante'),r.account)}${line(L('Contract','Contrato'),r.transaction.to)}${line(L('Network','Red'),'Robinhood · 4663')}${line(isSweep(r.action)?L('Pool quote fees (not a personal payout)','Comisiones del fondo (no es pago personal)'):L('Observed amount','Importe observado'),amount(e.amount,e.decimals,e.symbol))}${line(isSweep(r.action)?L('Creator destination','Destino del creador'):L('Fixed destination','Destino fijo'),isSweep(r.action)?e.creator:e.recipient)}<p class="receipt-note">${L('Simulation passed. Balances can change before execution. This review expires in two minutes; the contract has no deadline or minimum payout. Sweeping can distribute less than the displayed pool balance.','Simulación correcta. Los saldos pueden cambiar antes de ejecutar. Esta revisión vence en dos minutos; el contrato no tiene vencimiento ni pago mínimo. Distribuir puede pagar menos que el saldo mostrado.')}</p>${btn('sign',L('Sign in wallet','Firmar en la billetera'),'class="primary"')}${btn('cancel',L('Cancel review','Cancelar revisión'))}`;}
    if(pending){receipt+=`<p class="receipt-note">${L('A saved transaction needs confirmation.','Hay una transacción guardada por confirmar.')}</p>`;
      if(pending.txHash)receipt+=`<a class="text-link" href="${NETWORK.explorer}/tx/${esc(pending.txHash)}" target="_blank" rel="noopener noreferrer">${esc(pending.txHash)}</a>${btn('confirm',L('Check confirmation','Comprobar confirmación'))}`;
      else receipt+=`<label class="field">${L('Sent transaction hash','Hash de transacción enviada')}<input name="recoveryHash" maxlength="66" placeholder="0x…" autocomplete="off" spellcheck="false"></label>${btn('recover',L('Recover sent transaction','Recuperar transacción enviada'))}<p class="receipt-note">${L('If you rejected the wallet request, discard this unsigned review. Do not discard a transaction already sent.','Si rechazaste la solicitud en la billetera, descarta esta revisión sin firmar. No descartes una transacción ya enviada.')}</p>${btn('discard',L('Discard unsigned review','Descartar revisión sin firmar'))}`;
    }
    root.querySelector('#reward-review').innerHTML=receipt;
    if(social){root.querySelector('#reward-social-result').innerHTML=`${line(L('Resolved wallet','Billetera resuelta'),social.wallet)}<p class="receipt-note">${same(account,social.wallet)?L('Connected address matches. Signing control is still required; resolution is not authentication.','La dirección conectada coincide. Aún se requiere control para firmar; resolver no autentica.'):L('Connected wallet does not match. The beneficiary must access this exact wallet before they can spend received funds.','La billetera conectada no coincide. El beneficiario debe acceder a esta billetera exacta para gastar fondos recibidos.')}</p>`;}
  }
  async function run(action,attrs={}){
    if(busy||!root)return;const account=wallet().account,revision=epoch,recovery=root.querySelector('[name=recoveryHash]')?.value;
    const socialForm=root.querySelector('#rewards-social'),socialInput=socialForm?Object.fromEntries(new FormData(socialForm)):null;
    if(action==='cancel'){review=null;render();return;}
    if(action==='discard'){localStorage.removeItem(storageKey(account));render();return;}
    busy=true;error='';message=L('Checking…','Comprobando…');render();
    try{
      if(action==='connect'){await connect();watch();if(epoch===revision)message=L('Connected. Refresh balances.','Conectado. Actualiza los saldos.');return;}
      if(action==='resolve'){
        social=null;const result=await api('/api/recipients/resolve',socialInput);if(epoch!==revision)return;social=result;message=L('Address resolved. Wallet control remains unverified.','Dirección resuelta. El control sigue sin verificar.');return;
      }
      if(!account)throw new Error(L('Connect your wallet first.','Conecta tu billetera primero.'));
      if(action==='refresh'){
        review=null;await bound(account,revision);const result=await api('/api/rewards/positions',{account,chainId:4663});if(epoch!==revision)return;data=result;message=L('Balances read from chain.','Saldos consultados en cadena.');
      }else if(action==='prepare'){
        if(saved(account))throw new Error(L('Confirm or recover the saved transaction first.','Confirma o recupera la transacción guardada primero.'));
        await bound(account,revision);review=null;
        const result=await api('/api/rewards/prepare',{account,chainId:4663,action:attrs.action,...(attrs.token?{token:attrs.token}:{}),...(attrs.splitter?{splitter:attrs.splitter,recipient:attrs.recipient}:{})});
        await bound(account,revision);review=result;message=L('Review the destination, then sign.','Revisa el destino y firma.');
      }else if(action==='sign'){
        const r=review;if(!r||r.expiresAt<=Date.now()||!same(r.account,account)||!same(r.transaction.from,account)||Number(r.transaction.chainId)!==4663||BigInt(r.transaction.value)!==0n)throw new Error(L('Review expired or changed. Refresh and review again.','La revisión venció o cambió. Actualiza y revisa otra vez.'));
        const p=await bound(account,revision);if(Date.now()>=r.expiresAt)throw new Error(L('Review expired. Review again.','La revisión venció. Revisa otra vez.'));
        persist({id:r.id,account},account);const hash=await p.request({method:'eth_sendTransaction',params:[r.transaction]});
        if(!/^0x[0-9a-f]{64}$/i.test(hash??''))throw new Error(L('Wallet returned no transaction hash. Recover it from wallet activity.','La billetera no devolvió un hash. Recupéralo del historial.'));
        persist({id:r.id,account,txHash:hash},account);if(epoch!==revision)return;review=null;
        await confirm(saved(account),account,revision);
      }else if(action==='confirm'||action==='recover'){
        const pending=saved(account);if(!pending)throw new Error(L('No saved transaction.','No hay transacción guardada.'));
        if(action==='recover'){if(!/^0x[0-9a-f]{64}$/i.test(recovery??''))throw new Error(L('Paste the complete transaction hash.','Pega el hash completo.'));pending.txHash=recovery;}
        await confirm(pending,account,revision);
      }
    }catch(e){if(epoch===revision)error=e.code===4001?L('Wallet request rejected. No transaction was authorized.','Solicitud rechazada. No se autorizó una transacción.'):e.message;}
    finally{busy=false;if(root){render();if(epoch===revision){const target=root.querySelector(action==='prepare'&&!error?'#reward-review':'#rewards-status');target.tabIndex=-1;target.focus({preventScroll:true});if(action==='prepare'&&!error)target.scrollIntoView({block:'center'});}}}
  }
  async function confirm(pending,account,revision){
    const r=await api('/api/rewards/submit',{preparation:{id:pending.id},txHash:pending.txHash,account,chainId:4663});
    if(['confirmed','reverted','no-op','payment-unverified'].includes(r.status))localStorage.removeItem(storageKey(account));else persist(pending,account);
    if(epoch!==revision)return;
    message=r.status==='confirmed'?L('Payment verified on-chain. Refresh balances.','Pago verificado en cadena. Actualiza los saldos.'):r.status==='reverted'?L('Transaction reverted. No successful payment. Refresh before retrying.','La transacción revirtió. No hubo pago exitoso. Actualiza antes de reintentar.'):L('Pending canonical confirmation. Check again after more blocks.','Pendiente de confirmación canónica. Comprueba tras más bloques.');
    if(r.status==='no-op')message=L('Transaction confirmed without a fee distribution. Another sweep may have emptied the pool. Refresh balances.','Transacción confirmada sin distribución. Otro cobro pudo vaciar el fondo. Actualiza los saldos.');
    if(r.status==='payment-unverified'){message='';error=L('A configured payout could not be verified. The contract has no deferred recovery. Inspect the transaction in your wallet; do not assume payment succeeded.','No se pudo verificar un pago configurado. El contrato no tiene recuperación diferida. Revisa la transacción en tu billetera; no supongas que el pago tuvo éxito.');}
    data=null;
  }
  const click=e=>{const b=e.target.closest('[data-reward]');if(b&&root?.contains(b))run(b.dataset.reward,b.dataset);};
  const submit=e=>{if(e.target.id==='rewards-social'){e.preventDefault();run('resolve');}};
  const input=e=>{if(e.target.closest('#rewards-social')){socialDraft=Object.fromEntries(new FormData(root.querySelector('#rewards-social')));social=null;root.querySelector('#reward-social-result').textContent='';}};
  function mount(target=document.querySelector('#main')){destroy();root=target;if(!root)throw new Error('Rewards mount root not found.');root.addEventListener('click',click);root.addEventListener('submit',submit);root.addEventListener('input',input);watch();render();}
  function destroy(){epoch++;for(const c of requests)c.abort();requests.clear();provider?.removeListener?.('accountsChanged',invalidate);provider?.removeListener?.('chainChanged',invalidate);provider=null;root?.removeEventListener('click',click);root?.removeEventListener('submit',submit);root?.removeEventListener('input',input);root=null;data=null;review=null;social=null;}
  return {mount,invalidate,destroy};
}
