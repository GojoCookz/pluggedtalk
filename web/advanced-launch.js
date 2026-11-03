import { NETWORK,QUOTES } from '../lib/config.mjs';
import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { mediaUploader } from './media.js';
import { serverError } from './i18n.js';

// Advanced multi-market launch. Same form grid, receipt rail and wallet rules as the Carbon screen;
// the server refuses every preparation unless a verified plugged-advanced-v1 deployment exists.
export function advancedLaunchScreen({wallet,connect,language,esc,onConfirmed}) {
  const L=(en,es)=>language()==='es'?es:en;
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
  async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});const d=await r.json();if(!r.ok)throw new Error(d.error?serverError(d.error,language()):L('Request failed. Retry.','Error de solicitud. Reintenta.'));return d;}
  const api=(path,body)=>post('/api/advanced/'+path,body);
  const vaultApi=(path,body)=>post('/api/vault/'+path,body);
  const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
  const key=()=>Math.random().toString(36).slice(2,10);
  // A container holds exactly one currency, but the factory gives every quote pool's splitter the
  // same recipient list. A container inbox is therefore only correct in single-quote launches.
  function holdReason(){
    if(!vault)return L('Checking the fee vault…','Comprobando la bóveda de comisiones…');
    if(!vault.deployed)return serverError(vault.reason||'Fee vault is not deployed or not configured on this server.',language());
    if(input.markets.length!==1)return L('A container holds one currency, but all quote pools share this recipient list. Use a single quote pool to hold a recipient in a container.','Un contenedor guarda una sola moneda, pero todos los pools comparten esta lista de receptores. Usa un único pool para retener a un receptor en un contenedor.');
    return null;
  }
  function containerProblem(){
    for(const [i,r] of input.recipients.entries()){
      if(r.hold&&!r.container)return L(`Recipient ${i+1}: create its container or turn off holding.`,`Receptor ${i+1}: crea su contenedor o desactiva la retención.`);
      if(r.container&&(input.markets.length!==1||!same(r.container.currency,input.markets[0].quote)))return L(`Recipient ${i+1}: its container holds a different currency than this launch's single quote pool. Turn off holding or restore the original quote.`,`Receptor ${i+1}: su contenedor guarda una moneda distinta al único pool de este lanzamiento. Desactiva la retención o restaura la moneda original.`);
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
  const button=(action,en,es,extra='')=>`<button type="button" class="primary" data-advanced="${action}" ${extra} ${busy?'disabled':''}>${L(en,es)}</button>`;
  function marketRows(){
    return input.markets.map((m,i)=>`<div class="fields" data-market="${i}"><label class="field">${L('Quote','Moneda')} ${i+1}<select name="marketQuote">${erc20.map(q=>`<option value="${q.address}" ${q.address===m.quote?'selected':''}>${esc(q.symbol)} · ${q.address.slice(0,8)}…${q.address.slice(-4)}</option>`).join('')}</select></label>
      <label class="field">${L('Opening purchase','Compra inicial')}<input name="marketBuy" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(m.openingBuy)}" required></label>
      ${input.markets.length>1?`<button type="button" data-advanced="remove-market" data-index="${i}">${L('Remove','Quitar')}</button>`:''}</div>`).join('');
  }
  function recipientRows(){
    if(!input.recipients.length)return `<p class="receipt-note">${L('No rows: 100% of the creator share goes to the connected wallet.','Sin filas: el 100% de la parte del creador va a la billetera conectada.')}</p>`;
    const reason=holdReason();
    const note=`<p id="advanced-hold-note" class="receipt-note">${esc(reason?L('Reclaimable containers unavailable: ','Contenedores recuperables no disponibles: ')+reason:L('Optional: hold a recipient’s share in a reclaimable container. Fees wait in its inbox until that wallet accepts; after a decline or the window ends, they return to you.','Opcional: retén la parte de un receptor en un contenedor recuperable. Las comisiones esperan en su buzón hasta que esa billetera acepte; si rechaza o vence el plazo, vuelven a ti.'))}</p>`;
    return note+input.recipients.map((r,i)=>{
      const c=r.container,label=c?L(`Container inbox ${i+1}`,`Buzón del contenedor ${i+1}`):r.hold?L(`Recipient payout wallet ${i+1}`,`Billetera de cobro del receptor ${i+1}`):`${L('Wallet','Billetera')} ${i+1}`;
      const until=c?new Intl.DateTimeFormat(language(),{dateStyle:'medium'}).format(new Date(c.deadline*1000)):'';
      return `<div class="fields" data-recipient="${i}"><label class="field">${label}<input name="recipientAddress" autocomplete="off" spellcheck="false" maxlength="42" placeholder="0x…" value="${esc(r.address)}" required ${c?`readonly aria-describedby="container-note-${i}"`:''}></label>
      <label class="field">${L('Share (10000 = 100%)','Parte (10000 = 100%)')}<input name="recipientBps" type="number" min="1" max="10000" step="1" value="${esc(r.bps)}" required></label>
      <div class="field full"><label class="toggle"><input type="checkbox" name="recipientHold" ${r.hold?'checked':''} aria-describedby="advanced-hold-note">${L('Hold in reclaimable container','Retener en contenedor recuperable')}</label></div>
      ${r.hold&&!c?`<label class="field">${L('Response window (days, 7–365)','Plazo de respuesta (días, 7–365)')}<input name="recipientWindow" type="number" min="7" max="365" step="1" value="${esc(r.windowDays??30)}" required></label><div class="field"><button type="button" data-advanced="${r.pendingTx?'check-container':'create-container'}" data-index="${i}">${r.pendingTx?L('Check container confirmation','Comprobar confirmación del contenedor'):L('Create container','Crear contenedor')}</button></div>`:''}
      ${c?`<div class="field full"><p id="container-note-${i}" class="address-block">${L(`Container #${esc(c.id)}: fees go to this inbox. Wallet ${esc(c.recipient)} can accept until ${until}; otherwise you can reclaim them in Earnings.`,`Contenedor n.º ${esc(c.id)}: las comisiones van a este buzón. La billetera ${esc(c.recipient)} puede aceptar hasta el ${until}; si no, puedes recuperarlas en Ingresos.`)}</p></div>`:''}
      <button type="button" data-advanced="remove-recipient" data-index="${i}">${L('Remove','Quitar')}</button></div>`;}).join('');
  }
  function update(){
    if(!root())return;
    const status=$('#advanced-status');status.textContent=error||message;status.className=error?'error-list':'receipt-note';
    root().querySelectorAll('[data-advanced],#advanced-form input,#advanced-form select,#advanced-form button').forEach(e=>{if(!e.closest('#advanced-media'))e.disabled=busy||(!available()&&!['confirm','recover'].includes(e.dataset.advanced))||(e.name==='recipientHold'&&!e.checked&&Boolean(holdReason()))||(e.dataset.advanced==='create-container'&&Boolean(holdReason()));});
    const total=input.recipients.reduce((s,r)=>s+(Number(r.bps)||0),0);
    const sum=$('#recipient-sum');if(sum)sum.textContent=input.recipients.length?`${L('Total','Total')}: ${total} / 10000 bps`:'';
    const banner=$('#advanced-banner'),layout=$('#advanced-layout'),off=Boolean(config)&&!available();
    if(layout&&off&&!previewForm)layout.hidden=true;else if(layout)layout.hidden=false;
    if(banner)banner.innerHTML=off?`<div class="callout" role="status"><strong>${L('Advanced launch is not available yet','El lanzamiento avanzado aún no está disponible')}</strong>${esc(/profile is configured/.test(config.reason||'')?L('This server has no verified advanced deployment, so nothing can be prepared or signed here.','Este servidor no tiene un despliegue avanzado verificado, así que aquí no se puede preparar ni firmar nada.'):serverError(config.reason,language())||L('Advanced deployment unavailable.','Despliegue avanzado no disponible.'))} <a class="text-link" href="#create">${L('Use the standard launch','Usa el lanzamiento estándar')}</a></div>${layout?.hidden?`<button type="button" data-show-advanced>${L('Preview the form','Ver el formulario')}</button>`:''}`:'';
    const r=prepared;
    let html=`<h2>${L('Advanced receipt','Resumen avanzado')}</h2>${line(L('Opening target (all pools)','Objetivo inicial (todos los pools)'),'$2,500 USD')}${line(L('Pools','Pools'),String(input.markets.length))}${line(L('Wallet cap','Límite por billetera'),L('3%, no exemptions for creator or vault','3%, sin excepciones para creador o bóveda'))}`;
    const held=input.recipients.filter(x=>x.container).length;if(held)html+=line(L('Recipients held in containers','Receptores en contenedores'),String(held));
    if(r){
      html+=line(L('Supply','Suministro'),formatUnits(BigInt(r.params.supply),18))+line(L('Canonical name','Nombre canónico'),r.canonical.name)+line(L('Canonical ticker','Símbolo canónico'),r.canonical.symbol)+line(L('Trading fee','Comisión'),`${r.input.feeBps/100}%`)+line(L('Creator share','Parte del creador'),`${r.input.creatorBps/100}%`);
      for(const m of r.markets)html+=line(`${esc(m.symbol)} ${L('balance / needed','saldo / necesario')}`,`${formatUnits(BigInt(m.balance),m.decimals)} / ${formatUnits(BigInt(m.required),m.decimals)}`);
      html+=`<p class="receipt-note">${L('Review expires','Revisión válida hasta')}: ${new Date(r.expiresAt).toLocaleTimeString(language())}. ${L('USD conversion is an estimate.','La conversión USD es una estimación.')}</p>`;
      if(r.next==='fund')html+=`<p>${L('Fund this wallet with every selected quote, then review again.','Deposita cada moneda seleccionada y revisa de nuevo.')}</p>`;
      if(r.next==='approve')html+=r.approvals.map((a,i)=>button('approve',`${a.reset?'Reset':'Approve'} ${a.symbol}`,`${a.reset?'Restablecer':'Aprobar'} ${a.symbol}`,`data-index="${i}"`)).join('')+`<p class="receipt-note">${L('Approve each quote, then review again.','Aprueba cada moneda y revisa de nuevo.')}</p>`;
      if(r.next==='launch')html+=`<p class="gain">${L('Launch simulation passed.','Simulación correcta.')}</p>`+button('launch','Sign advanced launch','Firmar lanzamiento avanzado');
    }else html+=`<p class="receipt-note">${L('Review verifies the deployment, checks duplicates on-chain, refreshes pricing per quote and simulates once funded and approved.','La revisión verifica el despliegue, comprueba duplicados en cadena, actualiza precios por moneda y simula con fondos y aprobaciones.')}</p>`;
    html+=`<p class="receipt-note">${L('The cap limits each address, not a person using several. Each pool gets an equal supply slice. No launch deadline exists.','El límite aplica por dirección, no por persona con varias. Cada pool recibe una parte igual del suministro. No hay fecha límite de lanzamiento.')}</p>`;
    if(pending)html+=`<p class="receipt-note"><a class="text-link" href="${NETWORK.explorer}/tx/${esc(pending.txHash)}" target="_blank" rel="noopener noreferrer">${esc(pending.txHash)}</a></p>`+button('confirm','Check confirmation','Comprobar confirmación');
    else if(recoveryId())html+=`<details><summary>${L('Recover a sent launch','Recuperar un lanzamiento enviado')}</summary><label class="field">${L('Transaction hash from your wallet','Hash de tu billetera')}<input id="advanced-recovery-hash" name="transactionHash" autocomplete="off" spellcheck="false" maxlength="66" placeholder="0x…"></label>${button('recover','Check this transaction','Comprobar transacción')}</details>`;
    $('#advanced-receipt').innerHTML=html;
  }
  function renderLists(){const m=$('#advanced-markets'),r=$('#advanced-recipients');if(m)m.innerHTML=marketRows();if(r)r.innerHTML=recipientRows();$('[data-advanced=add-market]').hidden=input.markets.length>=4;$('[data-advanced=add-recipient]').hidden=input.recipients.length>=50;}
  function destroy(){capture();epoch++;prepared=null;message='';error='';uploader.destroy();hostRoot=null;}
  function mount(target=document.querySelector('#main')){
    destroy();
    const field=(key,label,extra='')=>`<label class="field">${label}<input name="${key}" autocomplete="off" spellcheck="false" value="${esc(input[key])}" ${extra}></label>`;
    target.innerHTML=`<div id="advanced-launch"><div class="page-top"><div><h1>${L('Advanced launch','Lanzamiento avanzado')}</h1><p>${L('Up to four pairing pools, up to 50 fee recipients and a strict 3% wallet cap. The same coin cannot launch twice. Your wallet signs every transaction.','Hasta cuatro pools, hasta 50 receptores de comisiones y un límite estricto del 3% por billetera. La misma moneda no puede lanzarse dos veces. Tu billetera firma cada transacción.')}</p></div><a class="text-link" href="#create">${L('Standard Carbon launch','Lanzamiento estándar de Carbon')}</a></div>
      <div id="advanced-banner"></div><div class="form-layout" id="advanced-layout"><div><form id="advanced-form" novalidate><section class="form-section"><h2>${L('Identity','Identidad')}</h2><div class="fields">${field('name',L('Name','Nombre'),'maxlength="64" required')}${field('symbol',L('Ticker','Símbolo'),'maxlength="12" pattern="[A-Za-z0-9]{1,12}" required')}
      <fieldset id="advanced-media" class="full"><legend>${L('Launch image','Imagen del lanzamiento')}</legend><div id="advanced-media-root"></div></fieldset>
      <details class="full cid-details" ${input.imageCid?'open':''}><summary>${L('I already have an image on IPFS','Ya tengo una imagen en IPFS')}</summary><p class="receipt-note">${L('IPFS is public file storage. Uploading above fills this in for you. Only paste here if your image is already stored on IPFS: copy its content ID (it starts with bafkrei or Qm).','IPFS es un almacenamiento público de archivos. Al subir arriba se rellena solo. Pega aquí solo si tu imagen ya está en IPFS: copia su identificador (empieza por bafkrei o Qm).')}</p><label class="field">${L('Image content ID','Identificador de la imagen')}<input name="imageCid" maxlength="100" autocomplete="off" spellcheck="false" placeholder="bafkrei… / Qm…" value="${esc(input.imageCid)}"></label></details></div>
      <p class="receipt-note">${L('Name and ticker are canonicalized on-chain (uppercase, single spaces). The same name, ticker and economics cannot launch twice, but a copy with different recipients can, so check the recipients of any launch you join.','El nombre y símbolo se normalizan en cadena (mayúsculas, espacios simples). El mismo nombre, símbolo y economía no pueden lanzarse dos veces, pero sí una copia con otros receptores: revisa los receptores de cualquier lanzamiento.')}</p></section>
      <section class="form-section"><h2>${L('Quote pools','Pools por moneda')}</h2><p class="receipt-note">${L('One to four unique quotes. Each pool opens at $2,500 divided by the pool count; each opening purchase is at most 2% of its pool value.','De una a cuatro monedas únicas. Cada pool abre con $2,500 dividido entre el número de pools; cada compra inicial es como máximo el 2% de su pool.')}</p><div id="advanced-markets"></div><button type="button" data-advanced="add-market">${L('Add quote pool','Añadir pool')}</button>
      <div class="fields">${field('milestoneUsd',L('Milestone, all pools (USD)','Hito, todos los pools (USD)'),'inputmode="decimal" required')}</div></section>
      <section class="form-section"><h2>${L('Fees and recipients','Comisiones y receptores')}</h2><div class="fields">${field('feeBps',L('Total trading fee (200 = 2%)','Comisión total (200 = 2%)'),'type="number" min="101" max="1000" step="1" required')}
      <label class="field">${L('Creator share of remaining fees','Parte del creador sobre el resto')}<select name="creatorBps">${[0,2500,5000,7500,10000].map(n=>`<option value="${n}" ${n===input.creatorBps?'selected':''}>${n/100}% ${L('creator','creador')} / ${100-n/100}% ${L('holders','titulares')}</option>`).join('')}</select></label></div>
      <div id="advanced-recipients"></div><p id="recipient-sum" class="receipt-note" aria-live="polite"></p><button type="button" data-advanced="add-recipient">${L('Add recipient','Añadir receptor')}</button></section>
      <section class="form-section"><h2>${L('Creator vesting','Bloqueo del creador')}</h2><div class="fields">${field('vestDays',L('Vesting days (0 = off, else ≥ 7)','Días de bloqueo (0 = no, o ≥ 7)'),'type="number" min="0" max="3650" step="1"')}${field('cliffDays',L('Cliff days','Días de carencia'),'type="number" min="0" max="3650" step="1"')}</div><p class="receipt-note">${L('Known limit: if someone sends you tokens so that your wallet plus the vested amount passes the 3% cap, releasing the vest fails until you move tokens out.','Límite conocido: si alguien te envía tokens y tu billetera más lo desbloqueado supera el 3%, liberar el bloqueo falla hasta que muevas tokens.')}</p></section>
      <button type="submit" class="primary">${L('Review advanced launch','Revisar lanzamiento avanzado')}</button></form><p id="advanced-status" role="status" aria-live="polite"></p></div>
      <aside id="advanced-receipt" class="plan-receipt rail-panel" aria-label="${L('Advanced receipt','Resumen avanzado')}"></aside></div></div>`;
    hostRoot=target.querySelector('#advanced-launch');const host=root();renderLists();
    host.addEventListener('input',event=>{
      if(!event.target.closest('#advanced-form')||event.target.closest('#advanced-media'))return;
      capture();if(event.target.name==='imageCid'&&!applyingPinned){uploader.destroy();uploader.mount($('#advanced-media-root'));}
      if(event.target.name==='recipientHold'){const i=event.target.closest('[data-recipient]').dataset.recipient;renderLists();$(`[data-recipient="${i}"] [name=recipientHold]`)?.focus();}
      invalidate();try{save();}catch{error=L('Enable browser storage before signing.','Activa el almacenamiento antes de firmar.');update();}
    });
    host.addEventListener('submit',event=>{if(event.target.id==='advanced-form'){event.preventDefault();run('prepare');}});
    host.addEventListener('click',event=>{if(event.target.closest('[data-show-advanced]')){previewForm=true;update();$('#advanced-layout input[name=name]')?.focus();return;}const b=event.target.closest('[data-advanced]');if(b)run(b.dataset.advanced,Number(b.dataset.index));});
    uploader.mount($('#advanced-media-root'));update();
    fetch('/api/advanced/config',{signal:AbortSignal.timeout(30000)}).then(r=>r.json()).catch(()=>({available:false,reason:L('Advanced status is unavailable. Retry shortly.','Estado avanzado no disponible. Reintenta pronto.')})).then(d=>{if(!root())return;config=d;update();});
    fetch('/api/vault/status',{signal:AbortSignal.timeout(30000)}).then(r=>r.json()).catch(()=>({deployed:false,reason:L('Fee vault status is unavailable. Retry shortly.','Estado de la bóveda no disponible. Reintenta pronto.')})).then(d=>{if(!root())return;vault=d;capture();renderLists();update();});
  }
  async function walletFor(expected,revision){
    const {account,provider}=wallet();if(!provider||account?.toLowerCase()!==expected.toLowerCase()||epoch!==revision)throw new Error(L('Wallet or form changed. Review again.','La billetera o el formulario cambió. Revisa de nuevo.'));
    if(Number(await provider.request({method:'eth_chainId'}))!==4663)throw new Error(L('Switch to Robinhood Chain (4663), then review again.','Cambia a Robinhood Chain (4663) y revisa de nuevo.'));
    const accounts=await provider.request({method:'eth_accounts'});if(accounts?.[0]?.toLowerCase()!==expected.toLowerCase()||epoch!==revision)throw new Error(L('Wallet changed. Review again.','La billetera cambió. Revisa de nuevo.'));return provider;
  }
  async function send(transaction,expiresAt,revision){const provider=await walletFor(transaction.from,revision);if(Date.now()>=expiresAt)throw new Error(L('Review expired. Review again before signing.','La revisión venció. Revisa antes de firmar.'));save();return provider.request({method:'eth_sendTransaction',params:[transaction]});}
  async function waitReceipt(provider,hash){
    for(let i=0;i<60;i++){const r=await provider.request({method:'eth_getTransactionReceipt',params:[hash]});if(r){if(r.status!=='0x1')throw new Error(L('Transaction reverted. Check your wallet.','La transacción revirtió. Revisa tu billetera.'));return;}await new Promise(r=>setTimeout(r,2000));}
    throw new Error(L('Still pending. Check your wallet, then review after confirmation.','Sigue pendiente. Revisa tu billetera y vuelve tras la confirmación.'));
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
    if($('[data-media-action=cancel]:not([hidden])')){error=L('Wait for the image upload or cancel it before continuing.','Espera a que termine la subida o cancélala antes de continuar.');update();return;}
    if(busy)return;if(!wallet().account&&!['confirm','recover'].includes(action)){await connect();return;}
    if(action==='prepare'&&!$('#advanced-form').reportValidity())return;
    capture();const operation={},revision=epoch,account=wallet().account,recoveryHash=$('#advanced-recovery-hash')?.value;activeRun=operation;busy=true;error='';message=L('Checking…','Comprobando…');update();
    try{
      if(action==='prepare'){
        if(!available())throw new Error(serverError(config?.reason,language())||L('Advanced deployment unavailable.','Despliegue avanzado no disponible.'));
        if(pending)throw new Error(L('Confirm your pending launch before preparing another.','Confirma el lanzamiento pendiente antes de preparar otro.'));
        const problem=containerProblem();if(problem)throw new Error(problem);
        await walletFor(account,revision);save();
        const body={...input,account,recipients:input.recipients.map(x=>({address:x.address,bps:x.bps}))};if(!body.recipients.length)delete body.recipients;if(!body.creatorBps)body.recipients=[];
        const r=await api('prepare',body);if(epoch!==revision)return;prepared=r;message=L('Review ready. Continue with the next action in your receipt.','Revisión lista. Continúa con la siguiente acción del resumen.');
      }else if(action==='approve'||action==='launch'){
        const r=prepared;if(!r)throw new Error(L('Review launch first.','Revisa el lanzamiento primero.'));
        const tx=action==='approve'?r.approvals[index]?.transaction:r.transaction;if(!tx||tx.from.toLowerCase()!==account.toLowerCase())throw new Error('Transaction/account mismatch.');
        const provider=wallet().provider;if(action==='launch')localStorage.setItem('plugged.advancedRecoveryId',r.id);
        const hash=await send(tx,r.expiresAt,revision);
        if(action==='launch'){pending={id:r.id,txHash:hash};localStorage.setItem('plugged.pendingAdvanced',JSON.stringify(pending));prepared=null;await handleConfirmation(await api('submit',pending),revision);}
        else{message=L('Approval sent. Waiting for confirmation…','Aprobación enviada. Esperando confirmación…');update();await waitReceipt(provider,hash);if(epoch===revision){prepared=null;message=L('Approval confirmed. Review again for the next approval, fresh pricing and simulation.','Aprobación confirmada. Revisa de nuevo para la siguiente aprobación, precio y simulación.');}}
      }else if(action==='create-container'||action==='check-container'){
        const r=input.recipients[index];if(!r)throw new Error(L('Recipient row changed. Retry.','La fila del receptor cambió. Reintenta.'));
        const reason=holdReason();if(reason&&action==='create-container')throw new Error(reason);
        const rowKey=r.key;let txHash=r.pendingTx?.txHash,prepId=r.pendingTx?.id;
        if(action==='create-container'){
          if(!/^0x[0-9a-fA-F]{40}$/.test(r.address))throw new Error(L(`Recipient ${index+1}: enter the resolved payout wallet (0x…, 42 characters).`,`Receptor ${index+1}: introduce la billetera de cobro resuelta (0x…, 42 caracteres).`));
          if(!Number.isInteger(r.windowDays)||r.windowDays<7||r.windowDays>365)throw new Error(L('Response window: whole days from 7 to 365.','Plazo de respuesta: días enteros de 7 a 365.'));
          await walletFor(account,revision);
          const prep=await vaultApi('prepare',{account,chainId:4663,action:'create',recipient:r.address,currency:input.markets[0].quote,windowDays:r.windowDays});
          if(prep.transaction.from.toLowerCase()!==account.toLowerCase()||!same(prep.expected.currency,input.markets[0].quote)||!same(prep.expected.recipient,r.address))throw new Error('Transaction/account mismatch.');
          txHash=await send(prep.transaction,prep.expiresAt,revision);prepId=prep.id;
          r.pendingTx={id:prepId,txHash};try{save();}catch{}
        }
        message=L('Container transaction sent. Waiting for three confirmations…','Transacción del contenedor enviada. Esperando tres confirmaciones…');update();
        let done=null;
        for(let i=0;i<60&&!done;i++){
          const s=await vaultApi('submit',{txHash,account,chainId:4663});
          if(s.status==='confirmed')done=s;else if(s.status==='reverted'||s.status==='reorg'){const row=input.recipients.find(x=>x.key===rowKey);if(row)delete row.pendingTx;try{save();}catch{}throw new Error(L(`Container transaction ${s.status==='reorg'?'was reorganized out':'reverted'}. Create it again.`,`La transacción del contenedor ${s.status==='reorg'?'fue reorganizada':'revirtió'}. Créalo de nuevo.`));}
          else await new Promise(res=>setTimeout(res,3000));
        }
        if(!done)throw new Error(L('Container still confirming. Use “Check container confirmation” shortly.','El contenedor sigue confirmándose. Usa «Comprobar confirmación del contenedor» en breve.'));
        // Only the inbox from the confirmed ContainerCreated event (cross-checked against vault storage) is used.
        const row=input.recipients.find(x=>x.key===rowKey);
        if(row){row.container={id:String(done.containerId),inbox:done.inbox,recipient:done.recipient,currency:done.currency,deadline:done.deadline};row.address=done.inbox;row.hold=true;delete row.pendingTx;}
        try{save();}catch{}renderLists();prepared=null;epoch++;
        message=L(`Container #${done.containerId} created. Its inbox now fills recipient ${index+1}.`,`Contenedor n.º ${done.containerId} creado. Su buzón ocupa ahora el receptor ${index+1}.`);
      }else if(action==='confirm'&&pending)await handleConfirmation(await api('status',{id:pending.id}),revision);
      else if(action==='recover'){
        const txHash=recoveryHash,id=recoveryId();
        if(!id||!/^0x[0-9a-f]{64}$/i.test(txHash??''))throw new Error(L('Paste the complete transaction hash.','Pega el hash completo de la transacción.'));
        const r=await api('submit',{id,txHash});pending={id,txHash};localStorage.setItem('plugged.pendingAdvanced',JSON.stringify(pending));await handleConfirmation(r,revision);
      }
    }catch(e){if(epoch===revision)error=e.message;}
    finally{if(activeRun===operation){activeRun=null;busy=false;update();if(root()&&epoch===revision){const target=$(error?'#advanced-status':action==='prepare'?'#advanced-receipt':'#advanced-status');target.tabIndex=-1;target.focus({preventScroll:true});if(innerWidth<781)target.scrollIntoView({block:'center'});}}}
  }
  async function handleConfirmation(r,revision){
    if(r.status==='confirmed'){if(epoch===revision)message=L(`Advanced launch confirmed: ${r.token}. It appears in Discover under Advanced once re-verified on-chain.`,`Lanzamiento avanzado confirmado: ${r.token}. Aparece en Explorar, sección Avanzado, tras verificarse de nuevo en cadena.`);pending=null;localStorage.removeItem('plugged.pendingAdvanced');localStorage.removeItem('plugged.advancedRecoveryId');await onConfirmed?.();}
    else if(r.status==='reverted'||r.status==='duplicate'){if(epoch===revision)error=L(`Transaction ${r.status}. Inspect it in your wallet.`,`Transacción: ${r.status}. Revísala en tu billetera.`);pending=null;localStorage.removeItem('plugged.pendingAdvanced');}
    else if(epoch===revision)message=L('Submitted. Check confirmation after two more blocks; the backend also tracks it.','Enviada. Comprueba la confirmación tras dos bloques más; el servidor también la sigue.');
  }
  return {mount,invalidate,destroy};
}
