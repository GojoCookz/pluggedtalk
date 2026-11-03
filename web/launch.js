import { NETWORK,QUOTES } from '../lib/config.mjs';
import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { mediaUploader } from './media.js';

// Reuse the existing product's form grid and receipt rail; no new UI framework.
export function launchScreen({wallet,connect,language,esc,onConfirmed}) {
  const L=(en,es)=>language()==='es'?es:en;
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
  async function api(path,body){const r=await fetch('/api/launches/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const d=await r.json();if(!r.ok)throw new Error(d.error||L('Request failed. Retry.','Error de solicitud. Reintenta.'));return d;}
  function capture(){const form=document.querySelector('#live-form');if(!form)return;const data=new FormData(form);for(const key of Object.keys(input))if(data.has(key))input[key]=['feeBps','creatorBps'].includes(key)?Number(data.get(key)):String(data.get(key));}
  const line=(label,value)=>`<div class="receipt-line"><span>${label}</span><strong>${esc(value)}</strong></div>`;
  const button=(action,en,es)=>`<button type="button" class="primary" data-live="${action}" ${busy?'disabled':''}>${L(en,es)}</button>`;
  function update(){
    if(!root())return;
    document.querySelector('#launch-status').textContent=error||message;
    document.querySelector('#launch-status').className=error?'error-list':'receipt-note';
    root().querySelectorAll('[data-live],#live-form input,#live-form select,#live-form button[type=submit]').forEach(e=>{if(!e.closest('#launch-media'))e.disabled=busy;});
    root().querySelector('#launch-media').disabled=busy;
    const target=document.querySelector('#live-receipt'),q=quote(),r=prepared;
    let html=`<h2>${L('Launch receipt','Resumen del lanzamiento')}</h2>${line(L('Opening target','Objetivo inicial'),'$2,500 USD')}${line(L('Supply','Suministro'),'1,000,000,000')}`;
    if(r&&q){
      html+=line(L('Wallet balance','Saldo'),`${formatUnits(BigInt(r.balance),q.decimals)} ${q.symbol}`)+line(L('Opening purchase','Compra inicial'),`${input.openingBuy} ${q.symbol}`)+line(L('Trading fee','Comisión'),`${r.input.feeBps/100}%`)+line(L('Platform / volume','Plataforma / volumen'),`${r.fees.platformVolumeBps/100}%`)+line(L('Creator / remaining fees','Creador / comisiones restantes'),`${r.input.creatorBps/100}%`);
      html+=`<p class="receipt-note">${L('Tick-rounded opening','Apertura redondeada por ticks')}: ${esc(formatUnits(BigInt(r.opening.realisedMarketCap),q.decimals))} ${esc(q.symbol)}. ${L('USD conversion is an estimate.','La conversión USD es una estimación.')}</p><p class="receipt-note">${L('Review expires','Revisión válida hasta')}: ${new Date(r.expiresAt).toLocaleTimeString(language())}</p>`;
      if(r.next==='fund')html+=`<p>${L('Fund this wallet with the selected quote, or swap native ETH below.','Deposita la moneda seleccionada o cambia ETH a continuación.')}</p>`;
      if(r.next==='approve')html+=BigInt(r.allowance)>0n?button('approve','Reset existing approval','Restablecer aprobación'):button('approve','Approve opening purchase','Aprobar compra inicial');
      if(r.next==='launch')html+=`<p class="gain">${L('Launch simulation passed.','Simulación correcta.')}</p>`+button('launch','Sign launch transaction','Firmar lanzamiento');
    }else html+=`<p class="receipt-note">${L('Review checks this pair, refreshes USD pricing and simulates once funded.','La revisión comprueba el par, actualiza el precio USD y simula cuando hay fondos.')}</p>`;
    html+=`<p class="receipt-note">${L('3% ordinary-wallet cap. Carbon exempts engine deliveries; this flow bounds the creator purchase. Funding, approval and launch are separate. Carbon has no launch deadline or minimum token-output field.','Límite del 3% para billeteras normales. Carbon exceptúa entregas del motor; este flujo limita la compra del creador. Fondos, aprobación y lanzamiento son separados. Carbon no tiene vencimiento ni salida mínima para lanzar.')}</p>`;
    if(pending)html+=`<p class="receipt-note"><a class="text-link" href="${NETWORK.explorer}/tx/${esc(pending.txHash)}" target="_blank" rel="noopener noreferrer">${esc(pending.txHash)}</a></p>`+button('confirm','Check confirmation','Comprobar confirmación');
    else if(recoveryId())html+=`<details><summary>${L('Recover a sent launch','Recuperar un lanzamiento enviado')}</summary><label class="field">${L('Transaction hash from your wallet','Hash de tu billetera')}<input id="recovery-hash" name="transactionHash" autocomplete="off" spellcheck="false" maxlength="66" placeholder="0x…"></label>${button('recover','Check this transaction','Comprobar transacción')}</details>`;
    target.innerHTML=html;
  }
  function destroy(){capture();epoch++;prepared=null;funding=null;message='';error='';uploader.destroy();hostRoot=null;}
  function mount(target=document.querySelector('#main')){
    destroy();
    const field=(key,label,extra='')=>`<label class="field">${label}<input name="${key}" autocomplete="off" spellcheck="false" value="${esc(input[key])}" ${extra}></label>`;
    target.innerHTML=`<div id="live-launch"><div class="page-top"><div><h1>${L('Launch your coin','Lanza tu moneda')}</h1><p>${L('Carbon’s Robinhood engine. Your wallet signs every transaction.','El motor de Carbon en Robinhood. Tu billetera firma cada transacción.')}</p></div><span class="form-actions"><a class="text-link" href="#advanced">${L('Advanced multi-pool launch','Lanzamiento multipool avanzado')}</a><a class="text-link" href="#planner">${L('Extended-feature planner','Planificador avanzado')}</a></span></div>
      <div class="form-layout"><div><form id="live-form"><section class="form-section"><h2>${L('Make it yours','Hazla tuya')}</h2><div class="fields">${field('name',L('Name','Nombre'),'maxlength="64" required')}${field('symbol',L('Ticker','Símbolo'),'maxlength="12" pattern="[A-Za-z0-9]{1,12}" required')}
      <fieldset id="launch-media" class="full"><legend>${L('Launch image','Imagen del lanzamiento')}</legend><div id="launch-media-root"></div></fieldset>
      <details class="full cid-details" ${input.imageCid?'open':''}><summary>${L('I already have an image on IPFS','Ya tengo una imagen en IPFS')}</summary><p class="receipt-note">${L('IPFS is public file storage. Uploading above fills this in for you. Only paste here if your image is already stored on IPFS: copy its content ID (it starts with bafkrei or Qm).','IPFS es un almacenamiento público de archivos. Al subir arriba se rellena solo. Pega aquí solo si tu imagen ya está en IPFS: copia su identificador (empieza por bafkrei o Qm).')}</p><label class="field">${L('Image content ID','Identificador de la imagen')}<input name="imageCid" maxlength="100" placeholder="bafkrei… / Qm…" value="${esc(input.imageCid)}"></label></details></div></section>
      <section class="form-section"><h2>${L('Market and opening purchase','Mercado y compra inicial')}</h2><div class="fields"><label class="field full">${L('Pairing coin','Moneda del par')}<select name="quote">${QUOTES.filter(q=>!q.native).map(q=>`<option value="${q.address}" ${q.address===input.quote?'selected':''}>${esc(q.symbol)} · ${q.address.slice(0,8)}…${q.address.slice(-4)}</option>`).join('')}</select></label>
      ${field('openingBuy',L('Your opening purchase (in the pairing coin)','Tu compra inicial (en la moneda del par)'),'inputmode="decimal" required')}${field('milestoneUsd',L('Milestone (USD)','Hito (USD)'),'inputmode="decimal" required')}</div><p class="receipt-note">${L('Pairing coin contract','Contrato de la moneda del par')}:</p><p class="address-block" id="live-quote-address">${esc(input.quote)}</p><p class="receipt-note">${L('Every coin opens at a $2,500 market cap. Your own first purchase is limited to about $50 worth of the pairing coin, so nobody starts with a large share. We check that the pair is approved for you.','Cada moneda abre con una capitalización de $2,500. Tu primera compra se limita a unos $50 en la moneda del par, para que nadie empiece con una gran parte. Comprobamos por ti que el par esté aprobado.')}</p></section>
      <section class="form-section"><h2>${L('Fees and rewards','Comisiones y recompensas')}</h2><p class="receipt-note">${L('Carbon keeps 1% of every trade. Choose a total fee above 1% and up to 10%; everything above 1% goes to the creator and holders.','Carbon se queda el 1% de cada operación. Elige una comisión total superior al 1% y de hasta el 10%; lo que supera el 1% va al creador y a los titulares.')}</p><div class="fields">${field('feeBps',L('Total trading fee (200 = 2%)','Comisión total (200 = 2%)'),'type="number" min="101" max="1000" step="1" required')}
      <label class="field">${L('Creator share of remaining fees','Parte del creador sobre el resto')}<select name="creatorBps">${[0,2500,5000,7500,10000].map(n=>`<option value="${n}" ${n===input.creatorBps?'selected':''}>${n/100}% ${L('creator','creador')} / ${100-n/100}% ${L('holders','titulares')}</option>`).join('')}</select></label><label class="field full">${L('Creator fee wallet (optional)','Billetera de comisiones (opcional)')}<input name="feeRecipient" placeholder="${L('Defaults to connected wallet','Por defecto, la billetera conectada')}" value="${esc(input.feeRecipient)}" maxlength="42"></label></div></section>
      <button type="submit" class="primary">${L('Review launch','Revisar lanzamiento')}</button></form>
      <details class="form-section funding-section"><summary>${L('Fund with ETH','Obtener fondos con ETH')}</summary><p>${L('Swap Robinhood-native ETH into your quote token first. A failed launch does not reverse this swap.','Cambia ETH nativo de Robinhood por la moneda del par primero. Un fallo del lanzamiento no revierte este cambio.')}</p><label class="field">ETH<input id="live-eth" inputmode="decimal" value="0.001"></label><button type="button" data-live="funding">${L('Review ETH swap','Revisar cambio de ETH')}</button><div id="funding-receipt" aria-live="polite"></div></details><p id="launch-status" role="status" aria-live="polite"></p></div><aside id="live-receipt" class="plan-receipt rail-panel" aria-label="${L('Launch receipt','Resumen del lanzamiento')}"></aside></div></div>`;
    hostRoot=target.querySelector('#live-launch');const host=root();host.querySelectorAll('input').forEach(el=>{el.autocomplete='off';el.spellcheck=false;});host.addEventListener('input',event=>{
      if(event.target.closest('#live-form')&&!event.target.closest('#launch-media')){capture();if(event.target.name==='imageCid'&&!applyingPinned){uploader.destroy();uploader.mount(host.querySelector('#launch-media-root'));}if(event.target.name==='quote'){input.openingBuy='';host.querySelector('[name=openingBuy]').value='';host.querySelector('#live-quote-address').textContent=input.quote;}invalidate();try{save();}catch{error=L('Enable browser storage before signing.','Activa el almacenamiento antes de firmar.');update();}}
      if(event.target.id==='live-eth'){epoch++;funding=null;host.querySelector('#funding-receipt').textContent='';}
    });
    host.addEventListener('submit',event=>{if(event.target.id==='live-form'){event.preventDefault();run('prepare');}});
    host.addEventListener('click',event=>{const button=event.target.closest('[data-live]');if(button)run(button.dataset.live);});uploader.mount(host.querySelector('#launch-media-root'));update();
  }
  async function walletFor(expected,revision){
    const {account,provider}=wallet();if(!provider||account?.toLowerCase()!==expected.toLowerCase()||epoch!==revision)throw new Error(L('Wallet or form changed. Review again.','La billetera o el formulario cambió. Revisa de nuevo.'));
    const chain=await provider.request({method:'eth_chainId'});
    if(Number(chain)!==4663)throw new Error(L('Switch to Robinhood Chain (4663), then review again.','Cambia a Robinhood Chain (4663) y revisa de nuevo.'));
    const accounts=await provider.request({method:'eth_accounts'});if(accounts?.[0]?.toLowerCase()!==expected.toLowerCase()||epoch!==revision)throw new Error(L('Wallet changed. Review again.','La billetera cambió. Revisa de nuevo.'));return provider;
  }
  async function send(transaction,expiresAt,revision){const provider=await walletFor(transaction.from,revision);if(Date.now()>=expiresAt)throw new Error(L('Review expired. Review again before signing.','La revisión venció. Revisa antes de firmar.'));save();return provider.request({method:'eth_sendTransaction',params:[transaction]});}
  async function waitReceipt(provider,hash){
    for(let i=0;i<60;i++){const r=await provider.request({method:'eth_getTransactionReceipt',params:[hash]});if(r){if(r.status!=='0x1')throw new Error(L('Transaction reverted. Check your wallet.','La transacción revirtió. Revisa tu billetera.'));return;}await new Promise(r=>setTimeout(r,2000));}
    throw new Error(L('Still pending. Check your wallet, then review after confirmation.','Sigue pendiente. Revisa tu billetera y vuelve tras la confirmación.'));
  }
  async function run(action){
    if(root()?.querySelector('[data-media-action=cancel]:not([hidden])')){error=L('Wait for the image upload or cancel it before continuing.','Espera a que termine la subida o cancélala antes de continuar.');update();return;}
    if(busy)return;if(!wallet().account&&!['confirm','recover'].includes(action)){await connect();return;}
    if(action==='prepare'&&!document.querySelector('#live-form').reportValidity())return;
    capture();const operation={},revision=epoch,account=wallet().account,recoveryHash=document.querySelector('#recovery-hash')?.value;activeRun=operation;busy=true;error='';message=L('Checking…','Comprobando…');update();
    try{
      if(action==='prepare'){
        if(pending)throw new Error(L('Confirm your pending launch before preparing another.','Confirma el lanzamiento pendiente antes de preparar otro.'));
        await walletFor(account,revision);save();const r=await api('prepare',{...input,account});if(epoch!==revision)return;prepared=r;message=L('Review ready. Continue with the next action in your receipt.','Revisión lista. Continúa con la siguiente acción del resumen.');
      }else if(action==='approve'||action==='launch'){
        const r=prepared;if(!r)throw new Error(L('Review launch first.','Revisa el lanzamiento primero.'));
        const tx=action==='approve'?r.approval:r.transaction;if(!tx||tx.from.toLowerCase()!==account.toLowerCase())throw new Error('Transaction/account mismatch.');
        const provider=wallet().provider;if(action==='launch')localStorage.setItem('plugged.launchRecoveryId',r.id);
        const hash=await send(tx,r.expiresAt,revision);
        if(action==='launch'){
           pending={id:r.id,txHash:hash};localStorage.setItem('plugged.pendingLaunch',JSON.stringify(pending));prepared=null;await handleConfirmation(await api('submit',pending),revision);
        }else{message=L('Approval sent. Waiting for confirmation…','Aprobación enviada. Esperando confirmación…');update();await waitReceipt(provider,hash);if(epoch===revision){prepared=null;message=L('Approval confirmed. Review again for fresh pricing and simulation.','Aprobación confirmada. Revisa de nuevo para actualizar precio y simulación.');}}
      }else if(action==='funding'){
        const amountEth=document.querySelector('#live-eth').value;await walletFor(account,revision);const r=await api('funding',{account,quote:input.quote,amountEth,slippageBps:50});if(epoch!==revision)return;funding=r;
        document.querySelector('#funding-receipt').innerHTML=`<p>${esc(amountEth)} ETH → ${esc(formatUnits(BigInt(r.outputAmount),quote().decimals))} ${esc(quote().symbol)}. ${L('Minimum','Mínimo')}: ${esc(formatUnits(BigInt(r.minimumOutput),quote().decimals))}. LI.FI · 0.5% ${L('slippage','deslizamiento')}.</p>`+button('swap','Sign ETH funding swap','Firmar cambio de ETH');message='';
      }else if(action==='swap'){
        if(!funding)throw new Error(L('Review the swap first.','Revisa el cambio primero.'));const provider=wallet().provider,hash=await send(funding.transaction,Date.parse(funding.expiresAt),revision);funding=null;
        message=L('Funding sent. Waiting for confirmation…','Fondos enviados. Esperando confirmación…');update();await waitReceipt(provider,hash);
        if(epoch===revision){prepared=null;document.querySelector('#funding-receipt').textContent='';message=L('Funding confirmed. Review launch to check your new balance.','Fondos confirmados. Revisa el lanzamiento para comprobar el saldo.');}
       }else if(action==='confirm'&&pending)await handleConfirmation(await api('submit',pending),revision);
      else if(action==='recover'){
        const txHash=recoveryHash,id=recoveryId();
        if(!id||!/^0x[0-9a-f]{64}$/i.test(txHash??''))throw new Error(L('Paste the complete transaction hash.','Pega el hash completo de la transacción.'));
         const r=await api('submit',{id,txHash});pending={id,txHash};localStorage.setItem('plugged.pendingLaunch',JSON.stringify(pending));await handleConfirmation(r,revision);
      }
    }catch(e){if(epoch===revision)error=e.message;}
    finally{if(activeRun===operation){activeRun=null;busy=false;update();if(root()&&epoch===revision){const target=document.querySelector(error?'#launch-status':action==='prepare'?'#live-receipt':'#launch-status');target.tabIndex=-1;target.focus({preventScroll:true});if(innerWidth<781)target.scrollIntoView({block:'center'});}}}
  }
  async function handleConfirmation(r,revision){
    if(r.status==='confirmed'){if(epoch===revision)message=L('Launch confirmed. Your coin is listed on Plugged.','Lanzamiento confirmado. Tu moneda aparece en Plugged.');pending=null;localStorage.removeItem('plugged.pendingLaunch');localStorage.removeItem('plugged.launchRecoveryId');await onConfirmed();}
    else if(r.status==='reverted'||r.status==='duplicate'){if(epoch===revision)error=L(`Transaction ${r.status}. Inspect it in your wallet.`,`Transacción: ${r.status}. Revísala en tu billetera.`);pending=null;localStorage.removeItem('plugged.pendingLaunch');}
    else if(epoch===revision)message=L('Submitted. Check confirmation after two more blocks; the backend also tracks it.','Enviada. Comprueba la confirmación tras dos bloques más; el servidor también la sigue.');
  }
  return {mount,invalidate,destroy};
}
