import { NETWORK, POLICY, QUOTES } from '../lib/config.mjs';
import { validatePlan } from '../lib/plan.mjs';
import { LOCALES, LOCALE_CODES, loadLocale, matchLanguage, translate, direction } from './i18n.js';
import { blankPrograms } from '../lib/programs.mjs';
import { rewardFields, programFields, captureOptions } from './options.js';
import { economicsFields, captureEconomics, curvePreview, updateValuation } from './economics-fields.js';
import { recipientLabel } from '../lib/recipients.mjs';
import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { launchScreen } from './launch.js';
import { tradingScreen } from './trading.js';
import { advancedLaunchScreen } from './advanced-launch.js';
import { rewardsScreen } from './rewards.js';
import { feeVaultScreen } from './fee-vault.js';
import { programsScreen } from './programs.js';
import { advancedDiscover, advancedTokenScreen, advancedRewardsScreen } from './advanced-markets.js';
import { welcomeScreen, legalScreen } from './welcome.js';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  programs:'M4 4h16v16H4Z M8 8h8M8 12h8M8 16h4',assets:'M4 5h16v14H4Z M8 9h8M8 13h5',
  discover:'M3 10l9-7 9 7v10H3Z M9 20v-7h6v7', create:'M12 5v14M5 12h14',
  earnings:'M4 7h16v13H4ZM4 7V4h13v3M16 12h4v4h-4Z',guide:'M5 4h10a4 4 0 0 1 4 4v12H8a3 3 0 0 1-3-3ZM5 16h14',
  search:'m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',sun:'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  moon:'M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12Z',close:'m6 6 12 12M6 18 18 6',people:'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 9v-2a6 6 0 0 1 12 0v2m2-16a4 4 0 0 1 0 8m1 3a5 5 0 0 1 3 5',
  plug:'M8 3v6m8-6v6M5 9h14v3a7 7 0 0 1-14 0Zm7 10v3',arrow:'M5 12h14m-5-5 5 5-5 5',back:'M19 12H5m5-5-5 5 5 5',trash:'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.plug}"/></svg>`;
function readStorage(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function persist(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
const storedLanguage = readStorage('plugged.language', null);
let lang = LOCALE_CODES.includes(storedLanguage) ? storedLanguage : matchLanguage(navigator.languages?.length ? navigator.languages : [navigator.language]);
let theme = readStorage('plugged.theme', 'light'); if (!['light','dark'].includes(theme)) theme = 'light';
const t = (key, args) => translate(lang, key, args);
const initialSearch = new URLSearchParams(location.search);
let source = 'plugged';
let sort = initialSearch.get('sort') === 'newest' ? 'newest' : 'trending';
let query = initialSearch.get('q') || '', marketState = 'loading', marketData = null, dirty = false;
let account = null, provider = null, providerHandlers = null, noticeTimer, connectionEpoch = 0, activeScreen = null;
let draftId = null;
let formState = blankDraft();
let assetData = null, assetState = 'idle', assetQuery = '', assetFilter = 'stock';
const providers = new Map();
const screenOptions={wallet:()=>({account,provider}),connect:()=>connect(),language:()=>lang,esc};
const liveLaunch=launchScreen({...screenOptions,onConfirmed:()=>loadMarkets()});
const advancedLaunch=advancedLaunchScreen({...screenOptions,onConfirmed:()=>loadMarkets()});
const liveTrading=tradingScreen(screenOptions),liveRewards=rewardsScreen(screenOptions),livePrograms=programsScreen(screenOptions);
const liveVault=feeVaultScreen(screenOptions);
const welcome=welcomeScreen({...screenOptions,t:(key,args)=>t(key,args)}),legal=legalScreen({t:(key,args)=>t(key,args),esc});
// Advanced launches: separate server-verified source, never merged into the baseline index.
const advancedList=advancedDiscover({language:()=>lang,esc,onChange:()=>updateAdvanced()});
const advancedToken=advancedTokenScreen({...screenOptions,trading:tradingScreen(screenOptions)}),advancedRewards=advancedRewardsScreen(screenOptions);
// Earnings hosts rewards plus the reclaimable fee-vault containers in sibling roots.
const liveEarnings={mount(root){root.innerHTML='<div data-earnings-rewards></div><div data-earnings-advanced></div><div data-earnings-vault></div>';liveRewards.mount(root.querySelector('[data-earnings-rewards]'));advancedRewards.mount(root.querySelector('[data-earnings-advanced]'));void liveVault.mount(root.querySelector('[data-earnings-vault]'));},
  invalidate(){liveRewards.invalidate();advancedRewards.invalidate();liveVault.invalidate();},destroy(){liveRewards.destroy();advancedRewards.destroy();liveVault.destroy();}};
function invalidateTransactions(){
  // Only the mounted screen can hold a preparation. render() destroys the previous
  // screen first; invalidating dormant modules would reconnect their wallet listeners.
  activeScreen?.invalidate();
  clearPreview('#eth-route-status');
}
function mountScreen(screen,root,coin){activeScreen=screen;screen.mount(root,coin);}
window.addEventListener('eip6963:announceProvider', event => {
  const detail = event.detail;
  if (detail?.info?.uuid && typeof detail.provider?.request === 'function') providers.set(detail.info.uuid, detail);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

function blankDraft() {
  return { name:'', symbol:'', description:'', github:'', website:'', quote:QUOTES.find(q=>q.native).address, holderBps:0,
    chainId:NETWORK.id, maxWalletBps:POLICY.maxWalletBps, recipients:[{address:'',bps:10000}],
    rewards:{developerEnabled:true,communityEnabled:false}, socials:{}, programs:blankPrograms(),
    economics:{mechanism:'direct-v4',openingMarketCapUsd:'2500',milestoneMarketCapUsd:'40000',creatorTaxBps:0,hybridEnabled:false,markets:[]} };
}
function savedDrafts() {
  const raw = readStorage('plugged.drafts', []);
  return Array.isArray(raw) ? raw.filter(row => typeof row?.id === 'string' && validatePlan(row.plan).ok).slice(0,50) : [];
}
function route() { return (location.hash.slice(1) || 'discover').split('/'); }
function short(address) { return address ? `${address.slice(0,6)}…${address.slice(-4)}` : ''; }
function amount(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat(lang, { style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:1 }).format(value) : '—';
}
function toast(message) {
  clearTimeout(noticeTimer); $('#notice').textContent = message; $('#notice').hidden = false;
  noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 6000);
}
function artwork(address = '0x1234567890') {
  // Address-derived identicon, not token artwork or a verified identity badge.
  const hex = address.replace(/^0x/,'').padEnd(40,'0'); let cells = '';
  for (let y=0;y<5;y++) for(let x=0;x<3;x++) if (parseInt(hex[y*3+x],16)%2) {
    cells += `<rect x="${8+x*6}" y="${8+y*6}" width="6" height="6"/>`;
    if (x<2) cells += `<rect x="${8+(4-x)*6}" y="${8+y*6}" width="6" height="6"/>`;
  }
  return `<svg class="coin-art" viewBox="0 0 46 46" aria-hidden="true"><g fill="currentColor" opacity=".8">${cells}</g></svg>`;
}
function usd(value) { const n=Number(value); return Number.isFinite(n)?new Intl.NumberFormat(lang,{style:'currency',currency:'USD',maximumFractionDigits:0}).format(n):`$${value}`; }
function empty(title, body, action = '', heading = 'h2') { return `<section class="empty">${icon('plug')}<${heading}>${esc(title)}</${heading}><p>${esc(body)}</p>${action}</section>`; }
function nav() {
  const current = route()[0];
  const html = ['discover','create','earnings','programs','assets','guide'].map(key => `<a class="nav-link" href="#${key}" ${current === key || ((current === 'token' || current === 'advanced-token') && key === 'discover') || (current === 'advanced' && key === 'create') ? 'aria-current="page"' : ''}>${icon(key)}${esc(t(key))}</a>`).join('');
  $('.desktop-nav').innerHTML = html; $('.mobile-nav').innerHTML = html;
  document.documentElement.lang = lang; document.documentElement.dir = direction(lang); document.documentElement.dataset.theme = theme;
  $('meta[name="theme-color"]').setAttribute('content',theme==='dark'?'#101713':'#f5f7f6');
  $('#language').value = lang; $('.language-code').textContent = lang.split('-')[0].toUpperCase(); $('#build-label').textContent = t('preview');
  $('#theme').innerHTML = icon(theme === 'light' ? 'moon':'sun'); $('#theme').setAttribute('aria-label',t(theme === 'light' ? 'dark':'light'));
  $('#wallet').innerHTML = `${icon('earnings')}<span>${esc(account ? short(account):t('connect'))}</span>`;
  $('#wallet').setAttribute('aria-label',account ? `${t('disconnect')} ${account}`:t('connect'));
  $('#wallet-title').textContent = t('walletTitle'); $('#close-wallet').innerHTML = icon('close'); $('#close-wallet').setAttribute('aria-label',t('close'));
  $('.skip').textContent = t('skip');
  $('.brand').setAttribute('aria-label',t('home'));
  $('.desktop-nav').setAttribute('aria-label',t('primaryNav'));
  $('.mobile-nav').setAttribute('aria-label',t('mobileNav'));
  $('.network-strip').setAttribute('aria-label',t('networkStatus'));
  $('label[for=language]').textContent=t('languageLabel');
  $('#notifications').setAttribute('aria-label',t('notifications'));
}
function rail() {
  return `<aside class="rail"><section class="rail-panel"><h2>${t('feesTitle')}</h2><p>${t('feesBody')}</p><div class="fee-path">
    <div class="fee-node">${icon('discover')}<span>${t('tradeFees')}</span></div><div class="fee-node">${icon('people')}<span>${t('splitFees')}</span></div><div class="fee-node">${icon('earnings')}<span>${t('claimFees')}</span></div></div>
    <p>${t('railNote')}</p><a href="#create" class="primary-link">${t('draftAction')}</a></section><p class="muted">${t('built')}</p>
    <div class="rail-footer"><a href="#guide">${t('guide')}</a><a href="https://docs.robinhood.com/chain" target="_blank" rel="noopener noreferrer">Robinhood</a></div></aside>`;
}
function coinCard(coin) {
  const change = coin.change24h;
  const changeText = typeof change === 'number' ? `${change > 0 ? '+':''}${new Intl.NumberFormat(lang,{maximumFractionDigits:1}).format(change)}%` : '—';
  const metrics = coin.marketCapUsd !== null || coin.volume24hUsd !== null;
  const cap = coin.maxWalletBps===null ? '—' : coin.maxWalletBps===0 ? t('capOff') : `${coin.maxWalletBps/100}%`;
  return `<a class="coin" href="#token/${coin.address}" aria-label="${esc(`${coin.name} ${coin.symbol} ${short(coin.address)}`)}"><div class="coin-head">${artwork(coin.address)}<div><h2 class="coin-name">${esc(coin.name)}</h2><small>${esc(coin.symbol)}</small> <span class="coin-addr">${short(coin.address)}</span></div></div>
    <div class="coin-stats"><div><small>${t(metrics?'marketcap':'launched')}</small><strong>${metrics?amount(coin.marketCapUsd):new Date(coin.launchedAt*1000).toLocaleDateString(lang,{month:'short',day:'numeric'})}</strong></div><div><small>${t(metrics?'volume':'capShort')}</small><strong>${metrics?amount(coin.volume24hUsd):cap}</strong></div></div>
    <div class="coin-foot"><span>${esc(coin.quoteSymbol)} · Carbon</span>${change===null?`<span>${t('unavailable')} · 24h</span>`:`<span class="${change >= 0 ? 'gain':'loss'}">${changeText} / 24h</span>`}</div></a>`;
}
function discover() {
  $('#main').innerHTML = `<div class="page-top"><div><h1>${t('headline')}</h1><p>${t('subhead')}</p></div><a class="primary-link" href="#create">${t('start')}</a></div>
    <div class="layout"><section><div class="source-tabs"><strong>${t('plugged')}</strong></div>
    <div class="toolbar"><label class="search">${icon('search')}<span class="sr-only">${t('search')}</span><input id="search" type="search" placeholder="${t('search')}" value="${esc(query)}"></label><div class="segments" aria-label="${t('discover')}"><button data-sort="trending" aria-pressed="${sort==='trending'}">${t('trending')}</button><button data-sort="newest" aria-pressed="${sort==='newest'}">${t('newest')}</button></div></div>
    <div id="market-results" aria-live="polite"></div><div id="advanced-results" aria-live="polite"></div></section>${rail()}</div>`;
  updateMarkets();updateAdvanced();
}
function updateAdvanced() { const target = $('#advanced-results'); if (target) target.innerHTML = advancedList.markup(query); }
function updateMarkets() {
  const target = $('#market-results'); if (!target) return;
  if (marketState === 'loading') { target.innerHTML = empty(t('loading'),t('loadHelp')); return; }
  if (marketState === 'error') { target.innerHTML = empty(t('noSource'),t('sourceError'),`<button data-refresh class="primary">${t('retry')}</button>`); return; }
  if (!marketData?.tokens.length) { target.innerHTML = empty(t('noLaunches'),t('noLaunchHelp'),`<a class="primary-link" href="#create">${t('draftAction')}</a>`) + draftsMarkup(); return; }
  const matching = marketData.tokens.filter(c => `${c.name} ${c.symbol} ${c.address}`.toLowerCase().includes(query.toLowerCase().trim()));
  const hasVolume = marketData.tokens.some(c=>c.volume24hUsd!==null);
  matching.sort((a,b) => sort === 'newest' ? b.launchedAt-a.launchedAt : (b.volume24hUsd ?? -1)-(a.volume24hUsd ?? -1) || b.launchedAt-a.launchedAt);
  target.innerHTML = `<div class="source-note"><p>${t('source')}<br>${t(hasVolume?'sample':'noVolume',{n:marketData.sampled})}<br><span>${new Date(marketData.observedAt).toLocaleString(lang)} · ${t('blockNumber',{n:esc(marketData.blockNumber)})}</span></p><button data-refresh>${t('refresh')}</button></div>
    ${marketData.warnings.map(w => `<p class="callout">${esc(w)}</p>`).join('')}
    ${matching.length ? `<div class="coin-grid">${matching.map(coinCard).join('')}</div>` : empty(t('noMatches'),t('changeSearch'),`<button data-reset>${t('reset')}</button>`)}`;
}
async function loadMarkets() {
  if (loadMarkets.busy) return;
  loadMarkets.busy = true; marketState = 'loading'; updateMarkets();
  try {
    const response = await fetch('/api/markets', {signal:AbortSignal.timeout(40000)});
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
    const data = await response.json();
    if (!Array.isArray(data.tokens) || data.chainId !== NETWORK.id) throw new Error();
    marketData = data; marketState = 'ready';
  } catch { marketState = 'error'; }
  finally { loadMarkets.busy = false; if (route()[0] === 'token') render(); else updateMarkets(); }
}
function draftsMarkup() {
  const drafts = savedDrafts();
  return `<div class="draft-list"><h2>${t('draftsTitle')}</h2><p class="muted">${t('localOnly')}</p>${drafts.length ? drafts.map(row => `<div class="draft-row"><div><strong>${esc(row.plan.name)}</strong> <small>${esc(row.plan.symbol)} · ${t('draft')}</small></div><button type="button" data-edit="${esc(row.id)}">${t('edit')}</button><button type="button" data-delete="${esc(row.id)}">${t('remove')}</button></div>`).join(''):`<p class="muted">${t('noDrafts')}</p>`}</div>`;
}
function recipientMarkup(row, index) {
  const kind=row.kind??'wallet';
  return `<div class="recipient-entry" data-recipient="${index}"><label class="field">${t('recipientType')} ${index+1}<select name="recipientKind">${['wallet','x','github'].map(k=>`<option value="${k}" ${kind===k?'selected':''}>${t('recipient-'+k)}</option>`).join('')}</select></label><div class="recipient"><label class="field">${t(kind==='wallet'?'walletAddress':'profileHandle')} ${index+1}<input name="${kind==='wallet'?'recipientAddress':'recipientUsername'}" spellcheck="false" autocomplete="off" placeholder="${kind==='wallet'?'0x…':'@username'}" maxlength="${kind==='wallet'?42:200}" value="${esc(kind==='wallet'?row.address:row.username)}" required></label><label class="field">${t('share')}<input name="recipientShare" type="number" min="0.01" max="100" step="0.01" inputmode="decimal" value="${row.bps/100}" required></label><button type="button" class="icon-button" data-remove-recipient="${index}" aria-label="${t('removeLabel',{n:index+1})}" ${formState.recipients.length===1?'disabled':''}>${icon('trash')}</button></div>${kind!=='wallet'?`<button type="button" data-resolve-recipient="${index}">${t('resolveProfile')}</button><p class="receipt-note" data-recipient-status role="status">${row.resolution?`${t('resolvedWallet')}: ${esc(row.resolution.wallet)}`:t('profilePending')}</p>`:''}</div>`;
}
function create() {
  const d = formState;
  d.rewards ??= { developerEnabled:d.holderBps<10000,communityEnabled:d.holderBps>0 };
  d.programs ??= blankPrograms(); d.socials ??= {};
  d.economics ??= {mechanism:'direct-v4',openingMarketCapUsd:'2500',milestoneMarketCapUsd:'40000',creatorTaxBps:0,hybridEnabled:false,markets:[]};
  if (!d.recipients.length) d.recipients = [{address:'',bps:10000}];
  $('#main').innerHTML = `<div class="page-top"><div><h1>${t('createTitle')}</h1><p>${t('createSub')}</p></div><button type="button" data-new-draft>${t('newDraft')}</button></div><div class="callout"><strong>${t('draftOnly')}</strong>${t('draftOnlyBody')}</div>
    <div class="form-layout"><form id="create-form"><section class="form-section"><h2>${t('identity')}</h2><p>${t('identityHint')}</p><div class="fields">
    <label class="field">${t('name')}<input name="name" maxlength="64" value="${esc(d.name)}" placeholder="${t('namePlaceholder')}" required></label>
    <label class="field">${t('ticker')}<input name="symbol" maxlength="12" pattern="[A-Za-z0-9]{1,12}" value="${esc(d.symbol)}" placeholder="${t('tickerPlaceholder')}" required></label>
    <label class="field full">${t('description')}<textarea name="description" maxlength="500" placeholder="${t('descPlaceholder')}">${esc(d.description)}</textarea></label></div><p class="receipt-note">${t('antiVampHint')}</p></section>
    <section class="form-section"><h2>${t('market')}</h2><p>${t('configuredQuotesHint')}</p><div class="fields"><label class="field">${t('quote')}<select name="quote">${QUOTES.map(q=>`<option value="${q.address}" ${d.quote===q.address?'selected':''}>${esc(q.symbol)} · ${q.address.slice(0,6)}…${q.address.slice(-4)}${q.issuerListed?' · stock':''}</option>`).join('')}</select></label><div class="field"><span>${t('cap')}</span><strong>${t('capValue')}</strong><small>${t('capHint')}</small></div></div><p id="selected-quote-address" class="address-block">${esc(d.quote)}</p><a class="text-link" href="#assets">${t('assets')}</a></section>
    ${economicsFields(d,t,esc)}
    <section class="form-section"><h2>${t('rewardsTitle')}</h2><p>${t('rewardDenominator')}</p>${rewardFields(d,t)}
    <fieldset class="recipient-fields" ${d.rewards.developerEnabled?'':'disabled'}><legend>${t('recipients')}</legend><p class="receipt-note">${t('socialRewardsHint')}</p><div id="recipient-rows">${d.recipients.map(recipientMarkup).join('')}</div><button type="button" data-add-recipient ${d.recipients.length>=POLICY.maxRecipients?'disabled':''}>${t('addRecipient')}</button></fieldset><div class="split-total"><span>${t('total')}</span><strong id="total-allocation"></strong></div></section>
    ${programFields(d,t,esc)}
    <section class="form-section"><h2>${t('links')}</h2><p>${t('linksHint')}</p><div class="fields"><label class="field full">${t('github')}<input name="github" type="url" maxlength="200" value="${esc(d.github)}" placeholder="https://github.com/owner/repo"></label><label class="field full">${t('website')}<input name="website" type="url" maxlength="300" value="${esc(d.website)}" placeholder="https://"></label>
    ${Object.entries({x:'https://x.com/',telegram:'https://t.me/',discord:'https://discord.gg/',farcaster:'https://farcaster.xyz/',youtube:'https://youtube.com/'}).map(([key,url])=>`<label class="field full">${t('social-'+key)}<input type="url" name="social-${key}" maxlength="300" value="${esc(d.socials[key]??'')}" placeholder="${url}"></label>`).join('')}</div></section>
    <p id="form-errors" class="error-list" role="alert"></p><div class="form-actions"><button type="submit" class="primary">${t('save')}</button><button type="button" data-export>${t('export')}</button></div>${draftsMarkup()}</form>
    <aside class="plan-receipt rail-panel" aria-label="${t('receipt')}"><div id="receipt"></div></aside></div>`;
  updateReceipt();
}
// Decimal text -> exact basis points. Extra precision is rejected, never silently rounded.
export function percentToBps(value) {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value)) return NaN;
  const [whole,fraction=''] = value.split('.'); return Number(whole)*100+Number(fraction.padEnd(2,'0'));
}
function captureForm() {
  const form = $('#create-form'); if (!form) return;
  const fields = new FormData(form);
  for (const key of ['name','symbol','description','github','website','quote']) formState[key] = String(fields.get(key)||'');
  formState.holderBps = percentToBps(String(fields.get('holderPercent')));
  captureOptions(fields,formState,percentToBps);
  captureEconomics(form,fields,formState,percentToBps);
  if(formState.rewards.developerEnabled)formState.recipients=[...form.querySelectorAll('[data-recipient]')].map((row,i)=>{
    const kind=row.querySelector('[name=recipientKind]').value,bps=percentToBps(row.querySelector('[name=recipientShare]').value);
    if(kind==='wallet')return {kind,address:row.querySelector('[name=recipientAddress]')?.value??'',bps};
    const username=row.querySelector('[name=recipientUsername]')?.value??'',previous=formState.recipients[i];
    return {kind,username,bps,...(previous?.kind===kind&&previous.username===username&&previous.resolution?{resolution:previous.resolution}:{})};
  });
}
function changeQuote(address) {
  if(formState.quote===address)return;
  formState.quote=address;
  if(formState.economics.markets[0])formState.economics.markets[0].quote=address;
}
function syncSearch() {
  const url = new URL(location.href);
  for(const [key,value] of Object.entries({source,sort,q:query})) value ? url.searchParams.set(key,value) : url.searchParams.delete(key);
  history.replaceState(null,'',url);
}
function updateReceipt() {
  curvePreview(formState,t,esc);
  const d = formState; const total = d.recipients.reduce((sum,row)=>sum+row.bps,0);
  $('#total-allocation').textContent = Number.isFinite(total) ? `${total/100}% / 100%` : '— / 100%';
  $('#total-allocation').className = total===10000 ? 'gain':'loss';
  const holder = Number.isInteger(d.holderBps) && d.holderBps>=0 && d.holderBps<=10000 ? d.holderBps : null;
  $('#receipt').innerHTML = `<div class="receipt-heading"><img src="/mark.svg" width="44" height="44" alt=""><div><h2>${esc(d.name||t('unnamed'))}</h2><small>${esc(d.symbol||'TOKEN')} · ${t('draft')}</small></div></div>
    <div class="receipt-line"><span>${t('quote')}</span><strong>${esc(QUOTES.find(q=>q.address===d.quote)?.symbol||'—')}</strong></div><div class="receipt-line"><span>${t('supply')}</span><strong>${new Intl.NumberFormat(lang).format(Number(POLICY.totalSupply))}</strong></div><div class="receipt-line"><span>${t('cap')}</span><strong>3%</strong></div>
    <div class="receipt-line"><span>${t('openingUsd')}</span><strong>$2,500</strong></div><div class="receipt-line"><span>${t('milestoneUsd')}</span><strong>${esc(usd(d.economics.milestoneMarketCapUsd??'40000'))}</strong></div>
    <div class="receipt-line"><span>${t('holderPool')}</span><strong>${holder===null?'—':holder/100+'%'}</strong></div><div class="receipt-line"><span>${t('recipientPool')}</span><strong>${holder===null?'—':(10000-holder)/100+'%'}</strong></div>
    ${(d.rewards?.developerEnabled?d.recipients:[]).map((row,index)=>`<div class="receipt-split"><div><span>${esc(row.kind&&row.kind!=='wallet'?recipientLabel(row):row.address?short(row.address):`${t('allRecipients')} ${index+1}`)}</span><strong>${Number.isFinite(row.bps)?row.bps/100+'%':'—'}</strong></div><progress aria-label="${t('allRecipients')} ${index+1}" max="10000" value="${Number.isFinite(row.bps)?Math.max(0,Math.min(10000,row.bps)):0}"></progress></div>`).join('')}
    ${d.programs?.fundraising.enabled?`<div class="receipt-line"><span>${t('fundraising')}</span><strong>${esc(d.programs.fundraising.goal||'—')} ${esc(QUOTES.find(q=>q.address===d.quote)?.symbol)}</strong></div><p class="receipt-note">${t('refundHint')}</p>`:''}
    ${d.programs?.cashback.enabled?`<div class="receipt-line"><span>${t('cashbackRate')}</span><strong>${d.programs.cashback.feeRebateBps/100}%</strong></div>`:''}
    <p class="receipt-note">${t('receiptNote')}</p><span class="build-state">${t('draftOnly')}</span>`;
}
async function savePlan(exportOnly=false) {
  captureForm(); const form = $('#create-form'); if (!form.reportValidity()) return;
  const result = validatePlan({...formState,recipients:formState.rewards.developerEnabled?formState.recipients:[]});
  if (!result.ok) { $('#form-errors').textContent = `${t('invalid')}\n${result.errors.join('\n')}`; $('#form-errors').scrollIntoView({block:'center'}); return; }
  const duplicate=savedDrafts().find(row=>row.id!==draftId&&validatePlan(row.plan).value?.antiVamp.key===result.value.antiVamp.key);
  if(duplicate){$('#form-errors').textContent=t('duplicateLaunch');return;}
  $('#form-errors').textContent = '';
  if (exportOnly) {
    const blob = new Blob([JSON.stringify(result.value,null,2)], {type:'application/json'});
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href=url; a.download=`plugged-${result.value.symbol.toLowerCase()}-draft.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); toast(t('exported')); return;
  }
  try {
    const drafts = savedDrafts(); draftId ??= crypto.randomUUID();
    const row = { id:draftId, updatedAt:new Date().toISOString(),plan:result.value };
    persist('plugged.drafts',[row,...drafts.filter(d=>d.id!==draftId)].slice(0,50));
    formState = {...result.value}; dirty=false; create(); toast(t('saved'));
  } catch { toast(t('storageError')); }
}
function guide() {
  $('#main').innerHTML = `<article class="guide"><div class="page-top"><div><h1>${t('guideTitle')}</h1><p>${t('guideSub')}</p></div></div>${Array.from({length:7},(_,i)=>`<details ${i===0?'open':''}><summary>${t('how'+(i+1))}</summary><p>${t('answer'+(i+1))}</p></details>`).join('')}<h2>${t('sources')}</h2><p class="muted">${t('preview')}</p><div class="form-actions"><a class="text-link" href="https://docs.bags.fm/how-to-guides/launch-token" target="_blank" rel="noopener noreferrer">Bags</a><a class="text-link" href="https://docs.robinhood.com/chain" target="_blank" rel="noopener noreferrer">Robinhood</a><a class="text-link" href="https://docs.uniswap.org/contracts/v4/deployments" target="_blank" rel="noopener noreferrer">Uniswap v4</a></div></article>`;
}
function tokenDetail(address) {
  const coin = marketState==='ready' ? marketData?.tokens.find(c=>c.address.toLowerCase()===address?.toLowerCase()) : null;
  if (!coin) {
    $('#main').innerHTML = `<a class="text-link" href="#discover">${t('back')}</a>${empty(t(marketState==='loading'?'loading':marketState==='error'?'noSource':'tokenMissing'),t(marketState==='loading'?'loadHelp':marketState==='error'?'sourceError':'tokenMissingHelp'),marketState==='loading'?'':`<button data-refresh>${t('refresh')}</button>`,'h1')}`; document.title=`${t(marketState==='loading'?'loading':'tokenMissing')} · Plugged`; return;
  }
  const cap = coin.maxWalletBps === null ? t('capUnknown') : coin.maxWalletBps===0 ? t('capOff') : `${coin.maxWalletBps/100}%`;
  const chart = coin.dexPair ? `<iframe class="chart" title="Dexscreener ${esc(coin.symbol)}" loading="lazy" src="https://dexscreener.com/robinhood/${coin.dexPair}?embed=1&theme=${theme}&trades=0&info=0" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>` : empty(t('chartMissing'),t('chartHelp'));
  $('#main').innerHTML = `<a class="text-link" href="#discover">${t('back')}</a><div class="detail-header">${artwork(coin.address)}<div><h1>${esc(coin.name)}</h1><p class="muted">${esc(coin.symbol)} / ${esc(coin.quoteSymbol)} · Carbon</p></div></div><div class="layout token-layout"><section class="token-source"><div class="detail-metrics"><div><small>${t('marketcap')}</small><strong>${amount(coin.marketCapUsd)}</strong></div><div><small>${t('volume')}</small><strong>${amount(coin.volume24hUsd)}</strong></div><div><small>${t('sourceCap')}</small><strong>${cap}</strong></div></div>${chart}<p class="address-block">${esc(coin.address)}</p><div class="form-actions"><button data-copy="${esc(coin.address)}">${t('copy')}</button><a class="primary-link" href="${NETWORK.explorer}/token/${esc(coin.address)}" target="_blank" rel="noopener noreferrer">${t('viewExplorer')}</a></div><p class="receipt-note">${t('capCaveat')}</p><p class="receipt-note">${t('source')} · ${new Date(marketData.observedAt).toLocaleString(lang)} · ${t('blockNumber',{n:esc(marketData.blockNumber)})}</p></section><aside id="token-trading" aria-label="${t('trade')}"></aside></div>`;
  mountScreen(liveTrading,$('#token-trading'),coin);
  document.title=`${coin.name} (${coin.symbol}) · Plugged`;
}
async function loadAssets() {
  if(assetState==='loading')return;
  assetState='loading';assetsView();
  try { const response=await fetch('/api/assets',{signal:AbortSignal.timeout(15000)});if(!response.ok){await response.body?.cancel();throw new Error();}assetData=await response.json();if(assetData.chainId!==NETWORK.id||!Array.isArray(assetData.assets))throw new Error();assetState='ready'; }
  catch{assetState='error';}
  if(route()[0]==='assets')assetsView();
}
function assetsView() {
  $('#main').innerHTML=`<div class="page-top"><div><h1>${t('assetTitle')}</h1><p>${t('assetHint')}</p></div><button type="button" data-assets-refresh>${t('refresh')}</button></div>
    <div class="callout"><strong>${t('assetScope')}</strong>${t('wormholeLimit')}</div>
    <div class="toolbar"><label class="search">${icon('search')}<span class="sr-only">${t('search')}</span><input id="asset-search" type="search" value="${esc(assetQuery)}" placeholder="${t('search')}"></label><label class="field">${t('assetFilter')}<select id="asset-filter"><option value="stock">${t('stocks')}</option><option value="all">${t('allAssets')}</option><option value="carbon">${t('carbonReferences')}</option><option value="bridge">${t('bridgeCandidates')}</option></select></label></div><div id="asset-results" aria-live="polite"></div>`;
  $('#asset-filter').value=assetFilter;updateAssets();
  if(assetState==='idle')loadAssets();
}
const ASSET_PAGE=24;let assetLimit=ASSET_PAGE;
function updateAssets() {
  const target=$('#asset-results');if(!target)return;
  if(assetState==='loading'||assetState==='idle'){target.innerHTML=empty(t('loading'),t('assetHint'));return;}
  if(assetState==='error'){target.innerHTML=empty(t('noSource'),t('sourceError'));return;}
  const rows=assetData.assets.filter(a=>(assetFilter==='all'||assetFilter==='stock'&&a.issuerListed||assetFilter==='carbon'&&a.carbonReferenced||assetFilter==='bridge'&&a.provenance.some(p=>p.includes('li.quest')))
    &&`${a.name} ${a.symbol} ${a.address}`.toLowerCase().includes(assetQuery.toLowerCase().trim()));
  const plural=(n,key)=>`${new Intl.NumberFormat(lang).format(n)} ${t(n===1?key+'One':key)}`,shown=rows.slice(0,assetLimit);
  target.innerHTML=`<p class="source-note">${plural(rows.length,'assetCount')} · ${new Intl.NumberFormat(lang).format(assetData.coverage.issuerAssets)} ${t('stocks')} · ${plural(assetData.pools.length,'providerPools')} · ${esc(new Date(assetData.indexedAt).toLocaleString(lang))}</p>
    <div class="asset-grid">${shown.map(a=>{const pools=assetData.pools.filter(p=>p.base===a.address||p.quote===a.address);return `<article class="asset-card"><h2>${esc(a.symbol)}</h2><p>${esc(a.name)}</p><p class="address-block"><span class="sr-only">${t('contractAddress')}: </span>${esc(a.address)}</p><p class="muted">${a.decimals} ${t('decimals')} · ${a.codeVerified===true?t('codeVerified'):t('quoteNotVerified')}</p>
    <details><summary>${t('provenance')} · ${plural(pools.length,'providerPools')}</summary><ul>${a.provenance.map(p=>`<li>${p.startsWith('https://')?`<a class="text-link" href="${esc(p)}" target="_blank" rel="noopener noreferrer">${esc(p)}</a>`:esc(p)}</li>`).join('')}</ul><p>${t('bridgeUnverified')}</p>${pools.map(p=>`<p><a class="text-link" href="${esc(p.source)}" target="_blank" rel="noopener noreferrer">${esc(p.dex)} · ${short(p.id)}</a> · ${short(p.base)} / ${short(p.quote)}</p>`).join('')}</details>
    <div class="form-actions"><a class="text-link" href="${NETWORK.explorer}/token/${a.address}" target="_blank" rel="noopener noreferrer">${t('viewExplorer')}</a>${QUOTES.some(q=>q.address===a.address)?`<button type="button" data-quote-select="${a.address}">${t('useQuote')}</button>`:''}</div></article>`;}).join('')}</div>${rows.length>shown.length?`<div class="form-actions"><button type="button" data-assets-more>${t('showMore',{n:Math.min(ASSET_PAGE,rows.length-shown.length)})}</button><span class="muted">${t('showingOf',{shown:shown.length,total:rows.length})}</span></div>`:''}`;
}
function render() {
  activeScreen?.destroy();activeScreen=null;
  nav(); const [page,address] = route();
  const entry=['welcome','terms','privacy'].includes(page);
  document.body.dataset.route=entry?'welcome':'app';
  if(!entry){try{persist('plugged.welcomed',true);}catch{}}
  if (page==='welcome') mountScreen(welcome,$('#main')); else if(page==='terms'||page==='privacy') mountScreen(legal,$('#main'),page); else if (page==='create') mountScreen(liveLaunch,$('#main')); else if(page==='advanced') mountScreen(advancedLaunch,$('#main')); else if(page==='planner') create(); else if(page==='earnings') mountScreen(liveEarnings,$('#main')); else if(page==='programs') mountScreen(livePrograms,$('#main')); else if(page==='assets') assetsView(); else if(page==='guide') guide(); else if(page==='token') tokenDetail(address); else if(page==='advanced-token') mountScreen(advancedToken,$('#main'),address); else discover();
  if(entry)document.title=`${t(page==='welcome'?'welcome.signIn':page==='terms'?'legal.termsTitle':'legal.privacyTitle')} · Plugged`;
  else if(page!=='token')document.title=`${t(page==='planner'?'plannerTitle':page==='advanced-token'?'advanced':['create','advanced','earnings','programs','assets','guide'].includes(page)?page:'discover')} · Plugged`;
}
async function connect(selected) {
  const dialog = $('#wallet-dialog');
  if (!selected) {
    if (window.ethereum && ![...providers.values()].some(p=>p.provider===window.ethereum)) providers.set('injected',{info:{name:t('browserWallet')},provider:window.ethereum});
    $('#wallet-options').innerHTML = `<p class="muted">${t('walletHelp')}</p>` + (providers.size ? [...providers.entries()].map(([id,p])=>`<button data-provider="${esc(id)}">${esc(String(p.info.name).slice(0,60))}</button>`).join('') : `<p>${t('walletNone')}</p>`);
    dialog.showModal(); return;
  }
  const requestEpoch=++connectionEpoch;
  try {
    const accounts = await selected.request({method:'eth_requestAccounts'});
    if(requestEpoch!==connectionEpoch)return;
    if (!Array.isArray(accounts) || !/^0x[0-9a-f]{40}$/i.test(accounts[0] || '')) throw new Error();
    disconnect(); provider=selected; account=accounts[0];
    providerHandlers = {
      accounts: accounts => { account = /^0x[0-9a-f]{40}$/i.test(accounts?.[0]||'') ? accounts[0] : null; invalidateTransactions(); nav(); },
      chain: chain => { invalidateTransactions();toast(t(Number(chain)===NETWORK.id?'walletConnected':'wrongChain')); },
      disconnect: () => { disconnect(); nav(); },
    };
    provider.on?.('accountsChanged',providerHandlers.accounts); provider.on?.('chainChanged',providerHandlers.chain); provider.on?.('disconnect',providerHandlers.disconnect);
    dialog.close();invalidateTransactions();nav();
    if(route()[0]==='welcome')location.hash='discover';
    const chain = await selected.request({method:'eth_chainId'}); if(provider===selected)toast(t(Number(chain)===NETWORK.id?'walletConnected':'wrongChain'));
  } catch { toast(t('walletRejected')); }
}
function disconnect() {
  connectionEpoch++;
  if (providerHandlers) {
    provider?.removeListener?.('accountsChanged',providerHandlers.accounts); provider?.removeListener?.('chainChanged',providerHandlers.chain); provider?.removeListener?.('disconnect',providerHandlers.disconnect);
  }
  account=null; provider=null; providerHandlers=null;
  invalidateTransactions();
}
function clearPreview(selector) {
  const target=$(selector);if(target){target.requestId=null;target.textContent='';}
}
$('#theme').addEventListener('click',()=>{captureForm();theme=theme==='light'?'dark':'light';try{persist('plugged.theme',theme);}catch{} render();});
$('#language').innerHTML=LOCALES.map(l=>`<option value="${l.code}" lang="${l.code}">${esc(l.name)}</option>`).join('');
$('#language').addEventListener('change',async event=>{captureForm();const next=event.target.value;if(!LOCALE_CODES.includes(next))return;await loadLocale(next);lang=next;clearTimeout(noticeTimer);$('#notice').hidden=true;invalidateTransactions();try{persist('plugged.language',lang);}catch{}render();});
$('#wallet').addEventListener('click',()=>{if(account){disconnect();nav();}else connect();});
$('#close-wallet').addEventListener('click',()=>{connectionEpoch++;$('#wallet-dialog').close();});
$('#wallet-dialog').addEventListener('cancel',()=>{connectionEpoch++;});
window.addEventListener('hashchange',()=>{captureForm();render();window.scrollTo(0,0);$('#main').focus({preventScroll:true});});
$('.skip').addEventListener('click',event=>{event.preventDefault();$('#main').focus();});
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
document.addEventListener('input',event=>{
  if(event.target.id==='search'){query=event.target.value;syncSearch();updateMarkets();updateAdvanced();}
  if(event.target.id==='asset-search'){assetQuery=event.target.value;assetLimit=ASSET_PAGE;updateAssets();}
  if(event.target.closest('#create-form')){
    const previousQuote=formState.quote;
    dirty=true;captureForm();const name=event.target.name;
    if(name==='milestoneMarketCapUsd')clearPreview('#usd-valuation');
    if(name==='routeAmountEth')clearPreview('#eth-route-status');
    if(name==='recipientUsername'){
      const status=event.target.closest('[data-recipient]').querySelector('[data-recipient-status]');
      status.requestId=null;status.textContent=t('profilePending');
    }
    if(name==='quote'){
      const selected=formState.quote;formState.quote=previousQuote;changeQuote(selected);
      create();$('[name=quote]').focus();return;
    }
    if(name==='recipientKind'){create();return;}
    if(name==='developerPercent'){formState.holderBps=10000-percentToBps(event.target.value);$('[name=holderPercent]').value=formState.holderBps/100;}
    if(name==='holderPercent')$('[name=developerPercent]').value=(10000-formState.holderBps)/100;
    if(['developerEnabled','communityEnabled'].includes(name)){
      const r=formState.rewards;
      if(!r.developerEnabled&&!r.communityEnabled)r[name==='developerEnabled'?'communityEnabled':'developerEnabled']=true;
      formState.holderBps=!r.developerEnabled?10000:!r.communityEnabled?0:formState.holderBps===0||formState.holderBps===10000?2500:formState.holderBps;
      create();$(`[name=${name}]`).focus();
    }else if(name==='hybridEnabled'){
      const e=formState.economics;
      if(e.hybridEnabled&&e.markets.length<2)e.markets=[{quote:formState.quote,allocationBps:5000},{quote:QUOTES.find(q=>q.address!==formState.quote).address,allocationBps:5000}];
      create();$(`[name=${name}]`).focus();
    }else if(['fundraisingEnabled','cashbackEnabled','charityEnabled'].includes(name)){
      if(name==='charityEnabled'&&formState.programs.charity.enabled){formState.programs.fundraising.enabled=true;formState.programs.refunds.enabled=true;}
      if(name==='fundraisingEnabled'&&!formState.programs.fundraising.enabled)formState.programs.charity.enabled=false;
      create();$(`[name=${name}]`).focus();
    }else updateReceipt();
  }
});
document.addEventListener('change',event=>{if(event.target.id==='asset-filter'){assetFilter=event.target.value;assetLimit=ASSET_PAGE;updateAssets();}});
document.addEventListener('submit',event=>{if(event.target.id==='create-form'){event.preventDefault();savePlan();}});
document.addEventListener('click',async event=>{
  const el=event.target.closest('button'); if(!el) return;
  if(el.dataset.source){source=el.dataset.source;syncSearch();discover();}
  if(el.dataset.sort){sort=el.dataset.sort;syncSearch();discover();}
  if(el.hasAttribute('data-refresh')) { loadMarkets(); advancedList.refresh(); }
  if(el.hasAttribute('data-advanced-refresh')) advancedList.refresh();
  if(el.hasAttribute('data-assets-refresh'))loadAssets();
  if(el.hasAttribute('data-assets-more')){const next=assetLimit;assetLimit+=ASSET_PAGE;updateAssets();const heading=document.querySelectorAll('#asset-results .asset-card')[next]?.querySelector('h2');if(heading){heading.tabIndex=-1;heading.focus();}}
  if(el.hasAttribute('data-add-market')){captureForm();if(formState.economics.markets.length<4){const quotes=new Set(formState.economics.markets.map(m=>m.quote));formState.economics.markets.push({quote:QUOTES.find(q=>!quotes.has(q.address)).address,allocationBps:0,openingCap:''});dirty=true;create();}}
  if(el.hasAttribute('data-remove-market')){captureForm();formState.economics.markets.splice(Number(el.dataset.removeMarket),1);dirty=true;create();}
  if(el.hasAttribute('data-refresh-price')){captureForm();await updateValuation(formState,t,esc,true);}
  if(el.hasAttribute('data-resolve-recipient')){
    captureForm();const index=Number(el.dataset.resolveRecipient),row=formState.recipients[index],kind=row.kind,username=row.username;
    const status=el.parentElement.querySelector('[data-recipient-status]'),requestId={};status.requestId=requestId;el.disabled=true;status.textContent=t('resolvingProfile');
    const current=()=>el.isConnected&&status.requestId===requestId&&formState.recipients[index]?.kind===kind&&formState.recipients[index]?.username===username;
    try{
      const response=await fetch('/api/recipients/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind,username}),signal:AbortSignal.timeout(18000)});
      const data=await response.json();if(!response.ok)throw new Error(data.error||t('profileResolveFailed'));
      if(!current())return;
      formState.recipients[index]={...formState.recipients[index],username:data.username,resolution:{wallet:data.wallet,receipt:data.receipt,providerId:data.providerId,expiresAt:data.expiresAt}};
      dirty=true;create();
    }catch(error){if(current())status.textContent=error.message;}
    finally{el.disabled=false;}
  }
  if(el.hasAttribute('data-eth-route')){
    captureForm();if(!account){await connect();return;}
    const selected=formState.quote,input=formState.economics.routeAmountEth,requestedAccount=account,status=$('#eth-route-status'),requestId={};status.requestId=requestId;el.disabled=true;status.textContent=t('loading');
    const current=()=>el.isConnected&&status.requestId===requestId&&account===requestedAccount&&formState.quote===selected&&formState.economics.routeAmountEth===input;
    try{
      const response=await fetch('/api/routes/quote',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({quote:selected,account,amountEth:input,slippageBps:50}),signal:AbortSignal.timeout(18000)});
      const data=await response.json();if(!response.ok)throw new Error(data.error||t('routeUnavailable'));
      if(!current())return;
      const quote=QUOTES.find(q=>q.address===selected);
      status.textContent=`${input} ETH → ${formatUnits(BigInt(data.outputAmount),quote.decimals)} ${quote.symbol}. ${t('minimumOutput')}: ${formatUnits(BigInt(data.minimumOutput),quote.decimals)} ${quote.symbol}. ${t('routeFundingOnly')}`;
    }catch(error){if(current())status.textContent=error.message;}
    finally{el.disabled=false;}
  }
  if(el.dataset.quoteSelect){captureForm();changeQuote(el.dataset.quoteSelect);dirty=true;location.hash='planner';}
  if(el.hasAttribute('data-reset')){query='';syncSearch();discover();}
  if(el.hasAttribute('data-add-recipient')){dirty=true;captureForm();if(formState.recipients.length<POLICY.maxRecipients)formState.recipients.push({address:'',bps:0});create();$('[data-recipient]:last-child input').focus();}
  if(el.hasAttribute('data-remove-recipient')){dirty=true;captureForm();if(formState.recipients.length>1)formState.recipients.splice(Number(el.dataset.removeRecipient),1);create();$('[data-add-recipient]').focus();}
  if(el.hasAttribute('data-export'))savePlan(true);
  if(el.hasAttribute('data-new-draft') && (!dirty || confirm(t('discardDraft')))){draftId=null;dirty=false;formState=blankDraft();create();$('[name="name"]').focus();}
  if(el.dataset.edit && (!dirty || confirm(t('discardDraft')))){const row=savedDrafts().find(row=>row.id===el.dataset.edit);if(row){draftId=row.id;dirty=false;formState=structuredClone(row.plan);if(route()[0]==='planner')create();else location.hash='planner';}}
  if(el.dataset.delete && confirm(t('confirmDelete'))){try{persist('plugged.drafts',savedDrafts().filter(row=>row.id!==el.dataset.delete));if(draftId===el.dataset.delete){draftId=null;dirty=false;formState=blankDraft();}render();toast(t('deleted'));}catch{toast(t('storageError'));}}
  if(el.dataset.copy){try{await navigator.clipboard.writeText(el.dataset.copy);toast(t('copied'));}catch{toast(t('copyFailed'));}}
  if(el.dataset.provider){const selected=providers.get(el.dataset.provider);if(selected)await connect(selected.provider);}
});
if (!(await loadLocale(lang))) lang = 'en';
// First-time visitors land on sign-in; returning visitors and deep links go straight in.
if(!location.hash&&!readStorage('plugged.welcomed',false))history.replaceState(null,'','#welcome');
render(); loadMarkets();
