import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { NETWORK } from '../lib/config.mjs';
import { TRADING_ERRORS,tradingErrorCode } from '../lib/trading-errors.mjs';

// Operate-mode extension: existing Plugged tokens and receipt, exact units, no invented prices.
export function tradingScreen({wallet,connect,language,esc}) {
  const L=(en,es)=>language()==='es'?es:en;
  const unitId='trade-unit-'+crypto.randomUUID();
  let host=null,coin=null,epoch=0,busy=false,review=null,balances=null,pending=null,recovery=null,recoveryHash='',message='',error='',timer=null;
  let input={side:'buy',amount:'',slippageBps:50,reviewSeconds:60};
  const controllers=new Set();
  const storeKey=(account,token)=>`plugged.trade.${account?.toLowerCase()}.${token?.toLowerCase()}${coin?.pool?'.'+coin.pool.toLowerCase():''}`;
  // Advanced coins carry the user-selected quote pool; every request names it explicitly.
  const scoped=body=>coin?.pool?{...body,pool:coin.pool}:body;
  const key=()=>storeKey(wallet().account,coin?.address);
  const storageError=()=>new Error(L('Browser storage is unavailable. Enable it before signing.','El almacenamiento no está disponible. Actívalo antes de firmar.'));
  const put=(k,value)=>{try{localStorage.setItem(k,JSON.stringify(value));}catch{throw storageError();}};
  const remove=k=>{try{localStorage.removeItem(k);}catch{throw storageError();}};
  function restore(){pending=null;recovery=null;try{const saved=JSON.parse(localStorage.getItem(key())||'null');if(saved?.id){recovery=saved;pending=saved.txHash?saved:null;}}catch{error=L('Browser storage is unavailable. Enable it before signing.','El almacenamiento no está disponible. Actívalo antes de firmar.');}}
  async function api(path,body){
    const controller=new AbortController();controllers.add(controller);
    const timeout=setTimeout(()=>controller.abort(),60000);
    try{const r=await fetch((coin?.pool?'/api/advanced/trading/':'/api/trading/')+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});const data=await r.json();if(!r.ok){const code=tradingErrorCode({code:data.code,message:data.error});throw Object.assign(new Error(TRADING_ERRORS[code][language()==='es'?1:0]),{code});}return data;}
    catch(e){if(TRADING_ERRORS[e.code])throw e;throw Object.assign(new Error(TRADING_ERRORS.TRADING_RPC[language()==='es'?1:0]),{code:'TRADING_RPC'});}
    finally{clearTimeout(timeout);controllers.delete(controller);}
  }
  const units=(raw,asset)=>`${formatUnits(BigInt(raw),asset.decimals)} ${asset.symbol}`;
  const line=(label,value)=>`<div class="receipt-line"><span>${label}</span><strong>${esc(String(value))}</strong></div>`;
  const button=(action,label,primary=false)=>`<button type="button" data-trade="${action}" ${primary?'class="primary"':''} ${busy?'disabled':''}>${label}</button>`;
  function update(){
    if(!host)return;
    const status=host.querySelector('[data-status]');status.textContent=error||message;status.className=error?'error-list':'receipt-note';status.setAttribute('role',error?'alert':'status');
    host.querySelectorAll('button,input,select').forEach(el=>el.disabled=busy);
    host.querySelector('[data-form]')?.setAttribute('aria-busy',String(busy));
    const balanceBox=host.querySelector('[data-balances]');
    balanceBox.innerHTML=balances?line(L('Coin balance','Saldo de moneda'),units(balances.token.balance,balances.token))+line(L('Quote balance','Saldo del par'),units(balances.quote.balance,balances.quote))+line(L('Native ETH for gas','ETH nativo para gas'),formatUnits(BigInt(balances.nativeBalance),18)+' ETH'):`<p class="receipt-note">${L('Connect and refresh to read your wallet balances.','Conecta y actualiza para leer tus saldos.')}</p>`;
    const r=review,receipt=host.querySelector('[data-receipt]'),replacementOpen=host.querySelector('[data-replace-details]')?.open;
    let html=`<h3>${L('Trade receipt','Resumen de operación')}</h3>`;
    if(r){
      html+=line(L('You spend up to','Gastas hasta'),units(r.amountIn,r.inputAsset));
      if(r.expectedOutput!==null){
        html+=line(L('Estimated receive · fees included','Recibes aprox. · comisiones incluidas'),units(r.expectedOutput,r.outputAsset));
        html+=line(L('Minimum receive','Mínimo recibido'),units(r.minimumOutput,r.outputAsset));
      }else html+=`<p class="receipt-note">${L('Output quote is unavailable until the input is funded and approved. No trade can be signed yet.','La cotización requiere saldo y aprobación. Aún no se puede firmar la operación.')}</p>`;
      html+=line(L('Slippage tolerance','Tolerancia de deslizamiento'),`${r.slippageBps/100}%`);
      if(r.gasCostEstimate)html+=line(L('Estimated gas budget','Presupuesto estimado de gas'),formatUnits(BigInt(r.gasCostEstimate),18)+' ETH');
      html+=`<p class="receipt-note">${L('Review valid until','Revisión válida hasta')} ${esc(new Date(r.expiresAt).toLocaleTimeString(language()))}. <strong>${L('Not an on-chain deadline.','No es un vencimiento en cadena.')}</strong></p>`;
      if(r.expiresAt<=Date.now())html+=`<p>${L('Review expired. Request a new quote.','La revisión venció. Solicita otra cotización.')}</p>`;
      else if(r.next==='fund')html+=`<p>${L('Add the input asset to your wallet, then review again. ETH funding is a separate swap.','Añade la moneda de entrada y revisa otra vez. Obtener fondos con ETH es un cambio separado.')}</p>`;
      else if(r.transaction&&!pending&&!recovery)html+=button('sign',r.next==='approve'?(r.approvalAmount==='0'?L('Reset token approval','Restablecer aprobación'):L('Approve exact input','Aprobar entrada exacta')):L('Sign trade','Firmar operación'),true);
      html+=`<details><summary>${L('Verify contract addresses','Verificar direcciones')}</summary>${line(L('Input token','Moneda de entrada'),r.inputAsset.address)}${line(L('Output token','Moneda de salida'),r.outputAsset.address)}${line(L('Approval spender / router','Contrato autorizado / router'),r.router)}</details>`;
    }else html+=`<p class="receipt-note">${L('Review an amount to check balances, approval and the deployed router. Minimum receive will be enforced on-chain.','Revisa un importe para comprobar saldos, aprobación y router. El mínimo recibido se aplica en cadena.')}</p>`;
    if(pending){
      const validHash=/^0x[0-9a-f]{64}$/i.test(pending.txHash);
      html+=`<p>${L('Transaction submitted. Check confirmation before another trade.','Transacción enviada. Comprueba la confirmación antes de otra operación.')}</p>`;
      if(validHash)html+=`<a class="text-link" href="${NETWORK.explorer}/tx/${esc(pending.txHash)}" target="_blank" rel="noopener noreferrer">${L('View transaction','Ver transacción')}</a>`;
      html+=button('confirm',L('Check confirmation','Comprobar confirmación'));
      html+=`<details data-replace-details ${replacementOpen?'open':''}><summary>${L('Sped up or cancelled in your wallet?','¿Aceleraste o cancelaste en tu billetera?')}</summary><p class="receipt-note">${L('Paste the replacement hash. A cancellation must be a zero-value transfer to your own wallet with the same nonce. New trades unlock only after confirmation.','Pega el hash de reemplazo. La cancelación debe ser una transferencia sin valor a tu propia billetera con el mismo nonce. Las nuevas operaciones se habilitan tras la confirmación.')}</p><label class="field">${L('Replacement transaction hash','Hash de la transacción de reemplazo')}<input name="replacementHash" data-recovery value="${esc(recoveryHash)}" maxlength="66" autocomplete="off" spellcheck="false" placeholder="0x…"></label>${button('replace',L('Check replacement','Comprobar reemplazo'))}</details>`;
    }else if(recovery){
      html+=`<p>${L('A wallet request may have been sent. Recover its hash before continuing; do not sign a duplicate.','Puede haberse enviado una solicitud. Recupera el hash antes de continuar; no firmes un duplicado.')}</p><label class="field">${L('Transaction hash from wallet','Hash de transacción de tu billetera')}<input name="recoveryHash" data-recovery value="${esc(recoveryHash)}" maxlength="66" autocomplete="off" spellcheck="false" placeholder="0x…"></label>${button('recover',L('Recover transaction','Recuperar transacción'))}${button('clear',L('Wallet confirms nothing was sent','La billetera confirma que no se envió'))}`;
    }
    receipt.innerHTML=html;
    const reviewButton=host.querySelector('[data-review]');reviewButton.disabled=busy||!!pending||!!recovery;
    reviewButton.classList.toggle('primary',!r?.transaction||r.expiresAt<=Date.now());
    host.querySelectorAll('[data-receipt] button,[data-receipt] input').forEach(el=>el.disabled=busy);
  }
  function render(){
    if(!host)return;
    host.innerHTML=`<section class="form-section" aria-label="${L('Trade coin','Operar moneda')}"><h2>${L('Trade','Operar')} ${esc(coin?.symbol||'')}</h2>
      ${coin?.address?`<form data-form novalidate><div class="fields"><label class="field">${L('Direction','Dirección')}<select name="side"><option value="buy" ${input.side==='buy'?'selected':''}>${L('Buy coin','Comprar moneda')}</option><option value="sell" ${input.side==='sell'?'selected':''}>${L('Sell coin','Vender moneda')}</option></select></label>
      <label class="field">${L('Input amount','Importe de entrada')}<input name="amount" value="${esc(input.amount)}" inputmode="decimal" autocomplete="off" spellcheck="false" required maxlength="60" aria-describedby="${unitId}"></label></div>
      <p id="${unitId}" class="receipt-note">${L('Input is in','La entrada se expresa en')} ${esc(input.side==='sell'?(coin.symbol||L('coin units','unidades de moneda')):(coin.quoteSymbol||L('quote-token units','unidades de la moneda del par')))}.</p>
      <details><summary>${L('Slippage and review validity','Deslizamiento y validez de revisión')}</summary><div class="fields"><label class="field">${L('Slippage (bps; 50 = 0.5%)','Deslizamiento (bps; 50 = 0,5%)')}<input name="slippageBps" type="number" min="0" max="500" step="1" value="${input.slippageBps}" required></label><label class="field">${L('Review validity (seconds)','Validez de revisión (segundos)')}<input name="reviewSeconds" type="number" min="30" max="120" step="1" value="${input.reviewSeconds}" required></label></div></details>
      <button data-review type="submit" class="primary">${wallet().account?L('Review trade','Revisar operación'):L('Connect wallet','Conectar billetera')}</button></form><div data-balances></div>${button('refresh',L('Refresh balances','Actualizar saldos'))}<div data-receipt></div>`:`<p>${L('Select a confirmed Plugged coin from the market to trade.','Selecciona una moneda confirmada de Plugged en el mercado.')}</p><div data-balances hidden></div><div data-receipt hidden></div><button data-review hidden></button>`}
      <p data-status role="status" aria-live="polite" tabindex="-1"></p>
      <p class="receipt-note">${L('The router has no on-chain deadline. A signed trade can execute later if its minimum output is met. Approvals, trades and native ETH funding are separate transactions.','El router no tiene vencimiento en cadena. Una operación firmada puede ejecutarse después si cumple el mínimo. Aprobaciones, operaciones y obtención de fondos con ETH son transacciones separadas.')}</p></section>`;
    update();
  }
  async function walletFor(account,revision){
    const {provider,account:current}=wallet();
    if(!provider||current?.toLowerCase()!==account?.toLowerCase()||revision!==epoch)throw new Error(L('Wallet changed. Review again.','La billetera cambió. Revisa otra vez.'));
    const [chain,accounts]=await Promise.all([provider.request({method:'eth_chainId'}),provider.request({method:'eth_accounts'})]);
    if(Number(chain)!==4663)throw new Error(L('Switch your wallet to Robinhood Chain (4663), then review again.','Cambia tu billetera a Robinhood Chain (4663) y revisa otra vez.'));
    if(accounts?.[0]?.toLowerCase()!==account.toLowerCase()||epoch!==revision)throw new Error(L('Wallet changed. Review again.','La billetera cambió. Revisa otra vez.'));
    return provider;
  }
  function completed(result,storageKey){
    if(['confirmed','reverted','cancelled'].includes(result.status)){
      remove(storageKey);pending=null;recovery=null;recoveryHash='';review=null;balances=null;
      if(result.status==='reverted')error=L('Transaction reverted. No trade completed. Refresh balances and review again.','La transacción revirtió. No se completó la operación. Actualiza saldos y revisa otra vez.');
      else if(result.status==='cancelled')message=L('Cancellation confirmed. Refresh balances and review again.','Cancelación confirmada. Actualiza saldos y revisa otra vez.');
      else message=result.next==='approve'?L('Approval confirmed. Review again for a fresh output quote.','Aprobación confirmada. Revisa otra vez para obtener una cotización actual.'):
        L(`Trade confirmed. Router output: ${units(result.actualOutput,result.outputAsset)}. Refresh balances before another trade.`,`Operación confirmada. Salida del router: ${units(result.actualOutput,result.outputAsset)}. Actualiza saldos antes de otra operación.`);
    }else message=result.status==='not_found'?L('RPC has not found this hash yet. Keep it saved and check again; do not resend.','El RPC aún no encuentra este hash. Guárdalo y comprueba otra vez; no reenvíes.'):
      L('Still pending or awaiting two additional blocks. Check again shortly.','Pendiente o esperando dos bloques adicionales. Comprueba de nuevo pronto.');
  }
  async function run(action){
    if(busy||!host||!coin?.address)return;
    if(!wallet().account){try{await connect();invalidate();}catch{error=L('Wallet connection failed. Open your wallet and try again.','La conexión falló. Abre tu billetera y reintenta.');update();}return;}
    if(action==='review'&&!host.querySelector('[data-form]').reportValidity())return;
    const revision=epoch,account=wallet().account,token=coin.address,storageKey=key(),enteredHash=recoveryHash.trim();
    busy=true;error='';message=L('Checking…','Comprobando…');update();
    try{
      if(action==='clear'){
        remove(storageKey);recovery=null;recoveryHash='';review=null;message=L('Recovery cleared. Review again before signing.','Recuperación borrada. Revisa otra vez antes de firmar.');
      }else if(['confirm','recover','replace'].includes(action)){
        const saved=pending||recovery,txHash=action==='confirm'?pending.txHash:enteredHash;
        if(!saved?.id||!/^0x[0-9a-f]{64}$/i.test(txHash??''))throw new Error(L('Paste the complete transaction hash.','Pega el hash completo.'));
        const result=await api('status',{id:saved.id,txHash,...(action==='replace'?{replaces:saved.txHash}:{})});if(revision!==epoch)return;
        pending={...saved,txHash};put(storageKey,pending);completed(result,storageKey);
      }else{
        await walletFor(account,revision);
        if(action==='refresh'){
          const result=await api('balances',scoped({token,account}));if(revision!==epoch)return;balances=result;message=L('Balances updated from Robinhood Chain.','Saldos actualizados desde Robinhood Chain.');
        }else if(action==='review'){
          if(pending||recovery)throw new Error(L('Resolve the pending wallet request first.','Resuelve primero la solicitud pendiente.'));
          review=null;const result=await api('quote',scoped({token,account,...input}));if(revision!==epoch)return;review=result;
          if(['approve','trade'].includes(result.next)){const prepared=await api('prepare',{id:result.id,account});if(revision!==epoch)return;review=prepared;}
          balances={token:review.side==='buy'?review.outputAsset:review.inputAsset,quote:review.side==='buy'?review.inputAsset:review.outputAsset,nativeBalance:review.nativeBalance,router:review.router};
          message=L('Review ready. Check the receipt before signing.','Revisión lista. Comprueba el resumen antes de firmar.');
        }else if(action==='sign'){
          const r=review;if(!r||pending||recovery||Date.now()>=r.expiresAt)throw new Error(L('Request a new review before signing.','Solicita otra revisión antes de firmar.'));
          // Re-simulate the ORIGINAL minimum, never silently replace the displayed quote.
          const prepared=await api('prepare',{id:r.id,account});if(revision!==epoch)return;
          const tx=prepared.transaction,provider=await walletFor(account,revision);
          if(!tx||prepared.id!==r.id||tx.from.toLowerCase()!==account.toLowerCase()||Number(tx.chainId)!==4663||tx.value!=='0x0'||tx.to?.toLowerCase()!==r.transaction?.to?.toLowerCase()||tx.data!==r.transaction?.data||Date.now()>=r.expiresAt)throw new Error(L('Transaction context changed. Review again.','El contexto cambió. Revisa otra vez.'));
          const saved={id:r.id,token,account,kind:r.next};put(storageKey,saved);recovery=saved;
          let hash;
          try{hash=await provider.request({method:'eth_sendTransaction',params:[tx]});}
          catch(e){if(e.code===4001){remove(storageKey);if(revision===epoch)recovery=null;}throw e;}
          if(!/^0x[0-9a-f]{64}$/i.test(hash??''))throw new Error(L('Wallet returned no valid hash. Recover it from wallet activity.','La billetera no devolvió un hash válido. Recupéralo de su actividad.'));
          // Preserve the hash even when navigation/account change happened during the wallet prompt.
          const sent={...saved,txHash:hash};put(storageKey,sent);
          if(revision!==epoch)return;pending=sent;recovery=sent;review=null;
          message=L('Sent. Checking confirmation…','Enviada. Comprobando confirmación…');update();
          const result=await api('submit',{id:r.id,txHash:hash});if(revision===epoch)completed(result,storageKey);
        }
      }
    }catch(e){if(revision===epoch)error=e.code===4001?L('Wallet request rejected. Nothing was signed.','Solicitud rechazada. No se firmó nada.'):
      L('Could not complete this step. Retry after checking your wallet. ','No se pudo completar este paso. Reintenta tras revisar tu billetera. ')+(typeof e.code==='number'?TRADING_ERRORS.TRADING_RPC[language()==='es'?1:0]:(e.message||TRADING_ERRORS.TRADING_RPC[language()==='es'?1:0]));}
    finally{busy=false;if(host){update();if(revision===epoch)host.querySelector('[data-status]').focus({preventScroll:true});}}
  }
  function changed(event){
    if(event.target.matches('[data-recovery]')){recoveryHash=event.target.value;return;}
    const name=event.target.name;if(!Object.hasOwn(input,name))return;
    input[name]=['slippageBps','reviewSeconds'].includes(name)?Number(event.target.value):event.target.value;
    epoch++;review=null;error='';message='';
    if(name==='side'){input.amount='';render();host.querySelector('[name=side]').focus({preventScroll:true});}else update();
  }
  function clicked(event){const button=event.target.closest('[data-trade]');if(button&&host.contains(button))void run(button.dataset.trade);}
  function submitted(event){event.preventDefault();void run('review');}
  function invalidate(){epoch++;review=null;balances=null;message='';error='';restore();if(host)render();}
  function destroy(){
    epoch++;clearInterval(timer);timer=null;for(const controller of controllers)controller.abort();
    if(host){host.removeEventListener('input',changed);host.removeEventListener('click',clicked);host.removeEventListener('submit',submitted);host.removeAttribute('data-plugged-trading');host.innerHTML='';}
    host=null;coin=null;review=null;balances=null;
  }
  function mount(root,nextCoin){
    destroy();host=root;coin=nextCoin;recoveryHash='';host.setAttribute('data-plugged-trading','');input={side:'buy',amount:'',slippageBps:50,reviewSeconds:60};
    restore();render();host.addEventListener('input',changed);host.addEventListener('click',clicked);host.addEventListener('submit',submitted);
    timer=setInterval(()=>{if(review&&!review.expired&&review.expiresAt<=Date.now()){review={...review,transaction:null,expired:true};update();}},1000);
    if(wallet().account&&coin?.address)void run('refresh');
  }
  return {mount,invalidate,destroy};
}
