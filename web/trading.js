import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { NETWORK } from '../lib/config.mjs';
import { TRADING_ERRORS,tradingErrorCode } from '../lib/trading-errors.mjs';
import { translate } from './i18n.js';

// Operate-mode extension: existing Plugged tokens and receipt, exact units, no invented prices.
export function tradingScreen({wallet,connect,language,esc}) {
  const L=(key,args)=>translate(language(),key,args);
  const unitId='trade-unit-'+crypto.randomUUID();
  let host=null,coin=null,epoch=0,busy=false,review=null,balances=null,pending=null,recovery=null,recoveryHash='',message='',error='',timer=null;
  let input={side:'buy',amount:'',slippageBps:50,reviewSeconds:60};
  const controllers=new Set();
  const storeKey=(account,token)=>`plugged.trade.${account?.toLowerCase()}.${token?.toLowerCase()}${coin?.pool?'.'+coin.pool.toLowerCase():''}`;
  // Advanced coins carry the user-selected quote pool; every request names it explicitly.
  const scoped=body=>coin?.pool?{...body,pool:coin.pool}:body;
  const key=()=>storeKey(wallet().account,coin?.address);
  const storageError=()=>new Error(L('trading.browserStorageUnavailableEnable'));
  const put=(k,value)=>{try{localStorage.setItem(k,JSON.stringify(value));}catch{throw storageError();}};
  const remove=k=>{try{localStorage.removeItem(k);}catch{throw storageError();}};
  function restore(){pending=null;recovery=null;try{const saved=JSON.parse(localStorage.getItem(key())||'null');if(saved?.id){recovery=saved;pending=saved.txHash?saved:null;}}catch{error=L('trading.browserStorageUnavailableEnable');}}
  async function api(path,body){
    const controller=new AbortController();controllers.add(controller);
    const timeout=setTimeout(()=>controller.abort(),60000);
    try{const r=await fetch((coin?.pool?'/api/advanced/trading/':'/api/trading/')+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});const data=await r.json();if(!r.ok){const code=tradingErrorCode({code:data.code,message:data.error});throw Object.assign(new Error(L('tradingError.'+code)),{code});}return data;}
    catch(e){if(TRADING_ERRORS[e.code])throw e;throw Object.assign(new Error(L('tradingError.TRADING_RPC')),{code:'TRADING_RPC'});}
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
    balanceBox.innerHTML=balances?line(L('trading.coinBalance'),units(balances.token.balance,balances.token))+line(L('trading.quoteBalance'),units(balances.quote.balance,balances.quote))+line(L('trading.nativeEthGas'),formatUnits(BigInt(balances.nativeBalance),18)+' ETH'):`<p class="receipt-note">${L('trading.connectRefreshReadWallet')}</p>`;
    const r=review,receipt=host.querySelector('[data-receipt]'),replacementOpen=host.querySelector('[data-replace-details]')?.open;
    let html=`<h3>${L('trading.tradeReceipt')}</h3>`;
    if(r){
      html+=line(L('trading.youSpendUp'),units(r.amountIn,r.inputAsset));
      if(r.expectedOutput!==null){
        html+=line(L('trading.estimatedReceiveFeesIncluded'),units(r.expectedOutput,r.outputAsset));
        html+=line(L('trading.minimumReceive'),units(r.minimumOutput,r.outputAsset));
      }else html+=`<p class="receipt-note">${L('trading.outputQuoteUnavailableUntil')}</p>`;
      html+=line(L('trading.slippageTolerance'),`${r.slippageBps/100}%`);
      if(r.gasCostEstimate)html+=line(L('trading.estimatedGasBudget'),formatUnits(BigInt(r.gasCostEstimate),18)+' ETH');
      html+=`<p class="receipt-note">${L('trading.reviewValidUntil')} ${esc(new Date(r.expiresAt).toLocaleTimeString(language()))}. <strong>${L('trading.notChainDeadline')}</strong></p>`;
      if(r.expiresAt<=Date.now())html+=`<p>${L('trading.reviewExpiredRequestNew')}</p>`;
      else if(r.next==='fund')html+=`<p>${L('trading.addInputAssetWallet')}</p>`;
      else if(r.transaction&&!pending&&!recovery)html+=button('sign',r.next==='approve'?(r.approvalAmount==='0'?L('trading.resetTokenApproval'):L('trading.approveExactInput')):L('trading.signTrade'),true);
      html+=`<details><summary>${L('trading.verifyContractAddresses')}</summary>${line(L('trading.inputToken'),r.inputAsset.address)}${line(L('trading.outputToken'),r.outputAsset.address)}${line(L('trading.approvalSpenderRouter'),r.router)}</details>`;
    }else html+=`<p class="receipt-note">${L('trading.reviewAmountCheckBalances')}</p>`;
    if(pending){
      const validHash=/^0x[0-9a-f]{64}$/i.test(pending.txHash);
      html+=`<p>${L('trading.transactionSubmittedCheckConfirmation')}</p>`;
      if(validHash)html+=`<a class="text-link" href="${NETWORK.explorer}/tx/${esc(pending.txHash)}" target="_blank" rel="noopener noreferrer">${L('trading.viewTransaction')}</a>`;
      html+=button('confirm',L('advancedLaunch.checkConfirmation'));
      html+=`<details data-replace-details ${replacementOpen?'open':''}><summary>${L('trading.spedUpCancelledWallet')}</summary><p class="receipt-note">${L('trading.pasteReplacementHashCancellation')}</p><label class="field">${L('trading.replacementTransactionHash')}<input name="replacementHash" data-recovery value="${esc(recoveryHash)}" maxlength="66" autocomplete="off" spellcheck="false" placeholder="0x…"></label>${button('replace',L('trading.checkReplacement'))}</details>`;
    }else if(recovery){
      html+=`<p>${L('trading.walletRequestMayHave')}</p><label class="field">${L('trading.transactionHashFromWallet')}<input name="recoveryHash" data-recovery value="${esc(recoveryHash)}" maxlength="66" autocomplete="off" spellcheck="false" placeholder="0x…"></label>${button('recover',L('advancedMarkets.recoverTransaction'))}${button('clear',L('advancedMarkets.walletConfirmsNothingWas'))}`;
    }
    receipt.innerHTML=html;
    const reviewButton=host.querySelector('[data-review]');reviewButton.disabled=busy||!!pending||!!recovery;
    reviewButton.classList.toggle('primary',!r?.transaction||r.expiresAt<=Date.now());
    host.querySelectorAll('[data-receipt] button,[data-receipt] input').forEach(el=>el.disabled=busy);
  }
  function render(){
    if(!host)return;
    host.innerHTML=`<section class="form-section" aria-label="${L('trading.tradeCoin')}"><h2>${L('advancedMarkets.trade')} ${esc(coin?.symbol||'')}</h2>
      ${coin?.address?`<form data-form novalidate><div class="fields"><label class="field">${L('trading.direction')}<select name="side"><option value="buy" ${input.side==='buy'?'selected':''}>${L('trading.buyCoin')}</option><option value="sell" ${input.side==='sell'?'selected':''}>${L('trading.sellCoin')}</option></select></label>
      <label class="field">${L('trading.inputAmount')}<input name="amount" value="${esc(input.amount)}" inputmode="decimal" autocomplete="off" spellcheck="false" required maxlength="60" aria-describedby="${unitId}"></label></div>
      <p id="${unitId}" class="receipt-note">${L('trading.input')} ${esc(input.side==='sell'?(coin.symbol||L('trading.coinUnits')):(coin.quoteSymbol||L('trading.quoteTokenUnits')))}.</p>
      <details><summary>${L('trading.slippageReviewValidity')}</summary><div class="fields"><label class="field">${L('trading.slippageBps500')}<input name="slippageBps" type="number" min="0" max="500" step="1" value="${input.slippageBps}" required></label><label class="field">${L('trading.reviewValiditySeconds')}<input name="reviewSeconds" type="number" min="30" max="120" step="1" value="${input.reviewSeconds}" required></label></div></details>
      <button data-review type="submit" class="primary">${wallet().account?L('trading.reviewTrade'):L('rewards.connectWallet')}</button></form><div data-balances></div>${button('refresh',L('rewards.refreshBalances'))}<div data-receipt></div>`:`<p>${L('trading.selectConfirmedPluggedCoin')}</p><div data-balances hidden></div><div data-receipt hidden></div><button data-review hidden></button>`}
      <p data-status role="status" aria-live="polite" tabindex="-1"></p>
      <p class="receipt-note">${L('trading.routerHasNoChain')}</p></section>`;
    update();
  }
  async function walletFor(account,revision){
    const {provider,account:current}=wallet();
    if(!provider||current?.toLowerCase()!==account?.toLowerCase()||revision!==epoch)throw new Error(L('trading.walletChangedReviewAgain'));
    const [chain,accounts]=await Promise.all([provider.request({method:'eth_chainId'}),provider.request({method:'eth_accounts'})]);
    if(Number(chain)!==4663)throw new Error(L('trading.switchWalletRobinhoodChain'));
    if(accounts?.[0]?.toLowerCase()!==account.toLowerCase()||epoch!==revision)throw new Error(L('trading.walletChangedReviewAgain'));
    return provider;
  }
  function completed(result,storageKey){
    if(['confirmed','reverted','cancelled'].includes(result.status)){
      remove(storageKey);pending=null;recovery=null;recoveryHash='';review=null;balances=null;
      if(result.status==='reverted')error=L('trading.transactionRevertedNoTrade');
      else if(result.status==='cancelled')message=L('trading.cancellationConfirmedRefreshBalances');
      else message=result.next==='approve'?L('trading.approvalConfirmedReviewAgain'):
        L('trading.tradeConfirmedRouterOutput',{p0:units(result.actualOutput,result.outputAsset)});
    }else message=result.status==='not_found'?L('trading.rpcHasNotFound'):
      L('trading.stillPendingAwaitingTwo');
  }
  async function run(action){
    if(busy||!host||!coin?.address)return;
    if(!wallet().account){try{await connect();invalidate();}catch{error=L('trading.walletConnectionFailedOpen');update();}return;}
    if(action==='review'&&!host.querySelector('[data-form]').reportValidity())return;
    const revision=epoch,account=wallet().account,token=coin.address,storageKey=key(),enteredHash=recoveryHash.trim();
    busy=true;error='';message=L('advancedLaunch.checking');update();
    try{
      if(action==='clear'){
        remove(storageKey);recovery=null;recoveryHash='';review=null;message=L('trading.recoveryClearedReviewAgain');
      }else if(['confirm','recover','replace'].includes(action)){
        const saved=pending||recovery,txHash=action==='confirm'?pending.txHash:enteredHash;
        if(!saved?.id||!/^0x[0-9a-f]{64}$/i.test(txHash??''))throw new Error(L('advancedMarkets.pasteCompleteTransactionHash'));
        const result=await api('status',{id:saved.id,txHash,...(action==='replace'?{replaces:saved.txHash}:{})});if(revision!==epoch)return;
        pending={...saved,txHash};put(storageKey,pending);completed(result,storageKey);
      }else{
        await walletFor(account,revision);
        if(action==='refresh'){
          const result=await api('balances',scoped({token,account}));if(revision!==epoch)return;balances=result;message=L('trading.balancesUpdatedFromRobinhood');
        }else if(action==='review'){
          if(pending||recovery)throw new Error(L('trading.resolvePendingWalletRequest'));
          review=null;const result=await api('quote',scoped({token,account,...input}));if(revision!==epoch)return;review=result;
          if(['approve','trade'].includes(result.next)){const prepared=await api('prepare',{id:result.id,account});if(revision!==epoch)return;review=prepared;}
          balances={token:review.side==='buy'?review.outputAsset:review.inputAsset,quote:review.side==='buy'?review.inputAsset:review.outputAsset,nativeBalance:review.nativeBalance,router:review.router};
          message=L('trading.reviewReadyCheckReceipt');
        }else if(action==='sign'){
          const r=review;if(!r||pending||recovery||Date.now()>=r.expiresAt)throw new Error(L('trading.requestNewReviewBefore'));
          // Re-simulate the ORIGINAL minimum, never silently replace the displayed quote.
          const prepared=await api('prepare',{id:r.id,account});if(revision!==epoch)return;
          const tx=prepared.transaction,provider=await walletFor(account,revision);
          if(!tx||prepared.id!==r.id||tx.from.toLowerCase()!==account.toLowerCase()||Number(tx.chainId)!==4663||tx.value!=='0x0'||tx.to?.toLowerCase()!==r.transaction?.to?.toLowerCase()||tx.data!==r.transaction?.data||Date.now()>=r.expiresAt)throw new Error(L('trading.transactionContextChangedReview'));
          const saved={id:r.id,token,account,kind:r.next};put(storageKey,saved);recovery=saved;
          let hash;
          try{hash=await provider.request({method:'eth_sendTransaction',params:[tx]});}
          catch(e){if(e.code===4001){remove(storageKey);if(revision===epoch)recovery=null;}throw e;}
          if(!/^0x[0-9a-f]{64}$/i.test(hash??''))throw new Error(L('trading.walletReturnedNoValid'));
          // Preserve the hash even when navigation/account change happened during the wallet prompt.
          const sent={...saved,txHash:hash};put(storageKey,sent);
          if(revision!==epoch)return;pending=sent;recovery=sent;review=null;
          message=L('trading.sentCheckingConfirmation');update();
          const result=await api('submit',{id:r.id,txHash:hash});if(revision===epoch)completed(result,storageKey);
        }
      }
    }catch(e){if(revision===epoch)error=e.code===4001?L('advancedMarkets.walletRequestRejectedNothing'):
      L('trading.couldNotCompleteStep')+(typeof e.code==='number'?L('tradingError.TRADING_RPC'):(e.message||L('tradingError.TRADING_RPC')));}
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
