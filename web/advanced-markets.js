import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { NETWORK } from '../lib/config.mjs';

// Advanced (plugged-advanced-v1) Discover cards, token page, per-pool trading and per-quote
// rewards. Strings are inline EN/ES. Everything shown comes from server re-verification.
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const short=a=>`${a.slice(0,6)}…${a.slice(-4)}`;
async function request(path,body){
  const r=await fetch(path,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)}:{signal:AbortSignal.timeout(60000)});
  const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||'Request failed.');return data;
}
const units=(raw,decimals,symbol,lang)=>{try{return `${new Intl.NumberFormat(lang,{maximumFractionDigits:6}).format(Number(formatUnits(BigInt(raw),decimals)))} ${symbol}`;}catch{return '—';}};

/** Discover section. Loads independently; baseline listings never wait on it. */
export function advancedDiscover({language,esc,onChange}){
  const L=(en,es)=>language()==='es'?es:en;
  let state='idle',data=null;
  async function load(){
    if(state==='loading')return;state='loading';onChange();
    try{data=await request('/api/advanced/markets');if(data.chainId!==NETWORK.id||!Array.isArray(data.tokens))throw new Error();state='ready';}
    catch{state='error';data=null;}
    onChange();
  }
  function markup(query=''){
    if(state==='idle')void load();
    const head=`<div class="source-tabs"><strong>${L('Advanced','Avanzado')}</strong></div>`;
    if(state==='loading'||state==='idle')return `<section aria-label="${L('Advanced launches','Lanzamientos avanzados')}">${head}<p class="receipt-note">${L('Verifying advanced launches on-chain…','Verificando lanzamientos avanzados en cadena…')}</p></section>`;
    if(state==='error')return `<section>${head}<p class="receipt-note">${L('Advanced market source is unavailable.','La fuente de mercados avanzados no está disponible.')}</p><button type="button" data-advanced-refresh>${L('Retry','Reintentar')}</button></section>`;
    if(!data.available)return `<section>${head}<p class="receipt-note">${L('Advanced launches are unavailable: ','Lanzamientos avanzados no disponibles: ')}${esc(data.reason||'')}</p></section>`;
    const q=query.toLowerCase().trim(),rows=data.tokens.filter(c=>`${c.name} ${c.symbol} ${c.address}`.toLowerCase().includes(q));
    const cards=rows.map(c=>`<a class="coin" href="#advanced-token/${esc(c.address)}" aria-label="${esc(`${c.name} ${c.symbol} ${L('Advanced','Avanzado')}`)}"><div class="coin-head"><div><h2 class="coin-name">${esc(c.name)}</h2><small>${esc(c.symbol)}</small> <span class="coin-addr">${short(c.address)}</span></div></div>
      <div class="coin-stats"><div><small>${L('Quote pools','Fondos del par')}</small><strong>${c.markets.length}</strong></div><div><small>${L('Wallet cap','Límite por billetera')}</small><strong>3%</strong></div></div>
      <div class="coin-foot"><span>${c.markets.map(m=>esc(m.symbol)).join(' · ')} · ${L('Advanced','Avanzado')}</span></div></a>`).join('');
    return `<section aria-label="${L('Advanced launches','Lanzamientos avanzados')}">${head}<p class="receipt-note">${L('Re-verified on-chain at block','Reverificado en cadena en el bloque')} ${esc(String(data.blockNumber))}. ${L('No price or volume index is connected for advanced pools.','No hay índice de precio o volumen para fondos avanzados.')}</p>
      ${rows.length?`<div class="coin-grid">${cards}</div>`:`<p class="receipt-note">${L('No confirmed advanced launches match.','No hay lanzamientos avanzados confirmados que coincidan.')}</p>`}
      ${data.unavailable.length?`<p class="callout">${data.unavailable.length} ${L('advanced launch(es) failed re-verification and are hidden from trading.','lanzamiento(s) avanzado(s) no superaron la reverificación y no se pueden operar.')}</p>`:''}
      ${data.truncated?`<p class="receipt-note">${L('Showing the latest 50 advanced launches.','Mostrando los últimos 50 lanzamientos avanzados.')}</p>`:''}</section>`;
  }
  return {markup,load,refresh(){state='idle';void load();}};
}

/** Token page: per-pool market facts plus a pool selector driving the shared trade panel. */
export function advancedTokenScreen({language,esc,trading}){
  const L=(en,es)=>language()==='es'?es:en;
  let host=null,epoch=0,token=null,pool=null;
  function panel(){
    const aside=host?.querySelector('#advanced-trading');if(!aside||!token)return;
    const m=token.markets.find(x=>same(x.pool,pool))??token.markets[0];pool=m.pool;
    trading.mount(aside,{address:token.address,symbol:token.symbol,quoteSymbol:m.symbol,pool:m.pool});
  }
  function render(error){
    if(!host)return;
    if(error||!token){host.innerHTML=`<a class="text-link" href="#discover">${L('Back to coins','Volver a monedas')}</a><section class="form-section"><h1>${L('Advanced token','Moneda avanzada')}</h1><p class="${error?'error-list':'receipt-note'}" role="status">${esc(error||L('Re-verifying on-chain…','Reverificando en cadena…'))}</p>${error?`<p class="receipt-note">${L('Trading stays unavailable until verification succeeds.','Las operaciones siguen no disponibles hasta que la verificación tenga éxito.')}</p>`:''}</section>`;return;}
    const lang=language(),rows=token.markets.map(m=>`<tr><td><label><input type="radio" name="advanced-pool" value="${esc(m.pool)}" ${same(m.pool,pool)?'checked':''}> ${esc(m.symbol)}</label></td><td>${units(m.marketCapQuote,m.decimals,m.symbol,lang)}</td><td>${(Number(m.graduationProgressBps)/100).toFixed(2)}%${m.graduated?` · ${L('graduated','graduado')}`:''}</td><td>${m.feeBps/100}%</td><td><span class="address-block">${esc(short(m.poolId))}</span></td></tr>`).join('');
    host.innerHTML=`<a class="text-link" href="#discover">${L('Back to coins','Volver a monedas')}</a><div class="detail-header"><div><h1>${esc(token.name)}</h1><p class="muted">${esc(token.symbol)} · ${L('Advanced','Avanzado')} · ${token.markets.length} ${L('quote pools','fondos del par')}</p></div></div>
      <div class="layout token-layout"><section class="token-source"><fieldset><legend>${L('Choose the quote pool to trade','Elige el fondo del par para operar')}</legend><div class="table-scroll"><table><thead><tr><th>${L('Pool','Fondo')}</th><th>${L('Pool value (hook)','Valor del fondo (hook)')}</th><th>${L('Milestone progress','Progreso del hito')}</th><th>${L('Fee','Comisión')}</th><th>${L('Pool ID','ID del fondo')}</th></tr></thead><tbody>${rows}</tbody></table></div></fieldset>
      <p class="receipt-note">${L('Each pool holds an equal supply slice and prices independently. Values are the hook’s quote-denominated market cap of that slice, not USD.','Cada fondo tiene una parte igual del suministro y cotiza por separado. Los valores son la capitalización del hook en la moneda del par, no USD.')}</p>
      <p class="receipt-note">${L('The token enforces a 3% wallet cap on every address; buys above it revert in simulation.','La moneda impone un límite del 3% por dirección; las compras que lo superen fallan en la simulación.')}</p>
      <p class="address-block">${esc(token.address)}</p><div class="form-actions"><a class="primary-link" href="${NETWORK.explorer}/token/${esc(token.address)}" target="_blank" rel="noopener noreferrer">${L('View on explorer','Ver en el explorador')}</a></div>
      <p class="receipt-note">${L('Verified at block','Verificado en el bloque')} ${esc(String(token.blockNumber))}</p></section><aside id="advanced-trading" aria-label="${L('Trade','Operar')}"></aside></div>`;
    panel();
  }
  function changed(event){if(event.target.name==='advanced-pool'){pool=event.target.value;panel();}}
  async function mount(root,address){
    destroy();host=root;const revision=++epoch;host.addEventListener('change',changed);render();
    try{const result=await request(`/api/advanced/token?address=${encodeURIComponent(address||'')}`);if(revision!==epoch)return;token=result;pool=result.markets[0]?.pool;render();}
    catch(e){if(revision===epoch)render(e.message);}
  }
  function destroy(){epoch++;trading.destroy();if(host){host.removeEventListener('change',changed);host.innerHTML='';}host=null;token=null;pool=null;}
  return {mount,destroy,invalidate(){trading.invalidate();}};
}

/** Earnings: per-quote sweeps, fixed-recipient releases and stuck-fee recovery. */
export function advancedRewardsScreen({wallet,connect,language,esc}){
  const L=(en,es)=>language()==='es'?es:en;
  let root=null,epoch=0,busy=false,data=null,message='',error='',hash='';
  const key=a=>`plugged.advancedRewards.pending.${a?.toLowerCase()}`;
  const saved=a=>{try{return JSON.parse(localStorage.getItem(key(a))||'null');}catch{return null;}};
  const label=a=>({sweep:L('Sweep pool fees','Distribuir comisiones del fondo'),release:L('Release my split','Cobrar mi parte'),'recover-splitter':L('Recover stuck creator fees','Recuperar comisiones bloqueadas del creador'),'recover-feed':L('Recover stuck holder fees','Recuperar comisiones bloqueadas de titulares')}[a]);
  const btn=(attrs,text)=>`<button type="button" ${attrs} ${busy?'disabled':''}>${text}</button>`;
  function render(){
    if(!root)return;const account=wallet().account,pending=saved(account),lang=language();
    const pools=data?.positions?.map(p=>p.status!=='verified'?`<section class="form-section"><h3>${esc(p.symbol||p.token)}</h3><p class="error-list">${esc(p.error)}</p></section>`:
      `<section class="form-section"><h3>${esc(p.name)} · ${esc(p.symbol)} · ${L('Advanced','Avanzado')}</h3>${p.pools.map(m=>`<div class="recipient-entry"><strong>${esc(m.symbol)} ${L('pool','fondo')}</strong>
        <div class="receipt-line"><span>${L('Unswept pool fees','Comisiones sin distribuir')}</span><strong>${units(m.pendingQuote,m.decimals,m.symbol,lang)}</strong></div>
        <div class="receipt-line"><span>${L('Stuck creator fees','Comisiones bloqueadas del creador')}</span><strong>${units(m.splitterStuck,m.decimals,m.symbol,lang)}</strong></div>
        <div class="receipt-line"><span>${L('Stuck holder fees','Comisiones bloqueadas de titulares')}</span><strong>${units(m.feedStuck,m.decimals,m.symbol,lang)}</strong></div>
        ${m.account?`<div class="receipt-line"><span>${L('Your split claimable','Tu parte disponible')} (${m.account.bps/100}%)</span><strong>${units(m.account.claimable,m.decimals,m.symbol,lang)}</strong></div>`:''}
        <p class="receipt-note">${L('Holder fees go to the basket ledger; holder claims from it are not available here yet.','Las comisiones de titulares van al libro de cesta; aún no se pueden cobrar aquí.')}</p>
        <div class="form-actions">${Object.entries(m.actions).filter(([,on])=>on).map(([a])=>btn(`data-adv-reward="${a}" data-token="${esc(p.token)}" data-pool="${esc(m.pool)}"`,label(a))).join('')}</div></div>`).join('')}</section>`).join('')??'';
    root.innerHTML=`<section class="form-section" aria-label="${L('Advanced rewards','Recompensas avanzadas')}"><h2>${L('Advanced launch rewards','Recompensas de lanzamientos avanzados')}</h2>
      <div class="form-actions">${btn(`data-adv-reward="${account?'refresh':'connect'}"`,account?L('Refresh advanced rewards','Actualizar recompensas avanzadas'):L('Connect wallet','Conectar billetera'))}</div>
      <p role="status" aria-live="polite" class="${error?'error-list':'receipt-note'}">${esc(error||message)}</p>
      ${data&&!data.available?`<p class="receipt-note">${L('Unavailable: ','No disponible: ')}${esc(data.reason||'')}</p>`:''}
      ${data?.available&&!data.positions.length?`<p class="receipt-note">${L('No confirmed advanced launches.','No hay lanzamientos avanzados confirmados.')}</p>`:''}${pools}
      ${pending?`<div class="callout"><p>${L('A reward transaction is pending. Check it before signing another.','Hay una transacción pendiente. Compruébala antes de firmar otra.')}</p>${pending.txHash?btn('data-adv-reward="check"',L('Check confirmation','Comprobar confirmación')):`<label class="field">${L('Transaction hash from wallet','Hash de la billetera')}<input data-adv-hash maxlength="66" value="${esc(hash)}" placeholder="0x…" autocomplete="off" spellcheck="false"></label>${btn('data-adv-reward="check"',L('Recover transaction','Recuperar transacción'))}${btn('data-adv-reward="clear"',L('Wallet confirms nothing was sent','La billetera confirma que no se envió'))}`}</div>`:''}</section>`;
  }
  async function bound(account,revision){
    const w=wallet();if(!w.provider||!same(w.account,account)||revision!==epoch)throw new Error(L('Wallet changed. Review again.','La billetera cambió. Revisa de nuevo.'));
    const [chain,accounts]=await Promise.all([w.provider.request({method:'eth_chainId'}),w.provider.request({method:'eth_accounts'})]);
    if(Number(chain)!==4663)throw new Error(L('Switch your wallet to Robinhood Chain (4663).','Cambia tu billetera a Robinhood Chain (4663).'));
    if(!same(accounts?.[0],account)||revision!==epoch)throw new Error(L('Wallet changed. Review again.','La billetera cambió. Revisa de nuevo.'));
    return w.provider;
  }
  async function run(button){
    const action=button.dataset.advReward;if(busy)return;
    if(action==='connect'){try{await connect();}catch{}return;}
    const account=wallet().account,revision=epoch;if(!account)return;
    busy=true;error='';message=L('Checking…','Comprobando…');render();
    try{
      if(action==='refresh'){data=await request('/api/advanced/rewards/positions',{account,chainId:4663});message=L('Read from Robinhood Chain.','Leído de Robinhood Chain.');}
      else if(action==='clear'){localStorage.removeItem(key(account));message='';}
      else if(action==='check'){
        const p=saved(account),txHash=p?.txHash||hash.trim();if(!p?.id||!/^0x[0-9a-f]{64}$/i.test(txHash))throw new Error(L('Paste the complete transaction hash.','Pega el hash completo.'));
        localStorage.setItem(key(account),JSON.stringify({...p,txHash}));
        const r=await request('/api/advanced/rewards/submit',{preparation:{id:p.id},txHash,account,chainId:4663});
        if(['confirmed','reverted','no-op','payment-deferred'].includes(r.status))localStorage.removeItem(key(account));
        message={confirmed:L('Confirmed on-chain.','Confirmado en cadena.'),reverted:L('Transaction reverted. Nothing was paid.','La transacción revirtió. No se pagó nada.'),'no-op':L('No fees were left to distribute.','No quedaban comisiones por distribuir.'),'payment-deferred':L('A payout was deferred by the hook. Use recover stuck fees.','El hook aplazó un pago. Usa recuperar comisiones bloqueadas.')}[r.status]??L('Still pending or confirming. Check again shortly.','Pendiente o confirmando. Comprueba pronto.');
      }else{
        if(saved(account))throw new Error(L('Resolve the pending transaction first.','Resuelve primero la transacción pendiente.'));
        const prepared=await request('/api/advanced/rewards/prepare',{account,chainId:4663,action,token:button.dataset.token,pool:button.dataset.pool});
        const provider=await bound(account,revision),tx=prepared.transaction;
        if(!same(tx.from,account)||Number(tx.chainId)!==4663||tx.value!=='0x0')throw new Error(L('Transaction context changed.','El contexto cambió.'));
        localStorage.setItem(key(account),JSON.stringify({id:prepared.id}));
        let txHash;try{txHash=await provider.request({method:'eth_sendTransaction',params:[tx]});}catch(e){if(e.code===4001)localStorage.removeItem(key(account));throw e;}
        localStorage.setItem(key(account),JSON.stringify({id:prepared.id,txHash}));
        message=L('Sent. Check confirmation after a few blocks.','Enviada. Comprueba la confirmación tras unos bloques.');
      }
    }catch(e){error=e.code===4001?L('Wallet request rejected. Nothing was signed.','Solicitud rechazada. No se firmó nada.'):e.message;}
    finally{busy=false;render();}
  }
  const clicked=e=>{const b=e.target.closest('[data-adv-reward]');if(b&&root?.contains(b))void run(b);};
  const typed=e=>{if(e.target.matches('[data-adv-hash]'))hash=e.target.value;};
  function mount(next){destroy();root=next;root.addEventListener('click',clicked);root.addEventListener('input',typed);render();}
  function destroy(){epoch++;if(root){root.removeEventListener('click',clicked);root.removeEventListener('input',typed);root.innerHTML='';}root=null;data=null;}
  return {mount,destroy,invalidate(){epoch++;data=null;message='';error='';render();}};
}
