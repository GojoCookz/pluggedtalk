import { formatUnits } from '../../app/node_modules/viem/_esm/index.js';
import { NETWORK, QUOTES } from '../lib/config.mjs';
import { serverError, translate } from './i18n.js';

// Advanced area: live chain activity for verified Plugged launches, coin pages with trades,
// price per swap, holders and wallet-signed callouts, creator profiles, a local watchlist and
// local price alerts. Every number comes from /api/activity (Robinhood Chain logs) or /api/callouts.
const WATCH_KEY = 'plugged.watchlist', ALERT_KEY = 'plugged.priceAlerts', POLL_MS = 15000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
const short = a => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function advancedHub({ wallet, connect, language, esc, notify, launch }) {
  const L = (key, args) => translate(language(), key, args);
  let root = null, view = 'live', arg = null, epoch = 0, timer = null, child = null, data = {}, calloutStatus = '', calloutBusy = false, tapeAll = false;
  const lang = () => language();
  const $ = selector => root?.querySelector(selector);

  async function get(path) {
    const r = await fetch(path, { signal: AbortSignal.timeout(40000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(serverError(body.error || L('hub.unavailable'), lang())), { status: r.status });
    return body;
  }
  async function post(path, payload) {
    const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(40000) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(serverError(body.error || L('hub.unavailable'), lang()));
    return body;
  }

  const num = (value, opts = {}) => new Intl.NumberFormat(lang(), { maximumFractionDigits: 2, ...opts }).format(value);
  const units = (raw, decimals) => { try { return num(Number(formatUnits(BigInt(raw), decimals)), { notation: 'compact', maximumFractionDigits: 2 }); } catch { return '—'; } };
  const price = value => typeof value === 'number' && Number.isFinite(value) ? num(value, { maximumSignificantDigits: 4, maximumFractionDigits: 20 }) : '—';
  const pct = bps => `${num(bps / 100, { maximumFractionDigits: 2 })}%`;
  const ago = seconds => {
    if (!seconds) return '—';
    const diff = Math.round(seconds - Date.now() / 1000), rtf = new Intl.RelativeTimeFormat(lang(), { numeric: 'auto', style: 'short' });
    const abs = Math.abs(diff);
    return abs < 60 ? rtf.format(diff, 'second') : abs < 3600 ? rtf.format(Math.round(diff / 60), 'minute') : abs < 86400 ? rtf.format(Math.round(diff / 3600), 'hour') : rtf.format(Math.round(diff / 86400), 'day');
  };
  const duration = seconds => {
    if (!seconds) return L('hub.recentBlocks');
    const hours = seconds / 3600;
    return hours >= 1 ? new Intl.NumberFormat(lang(), { style: 'unit', unit: 'hour', unitDisplay: 'long', maximumFractionDigits: 0 }).format(hours)
      : new Intl.NumberFormat(lang(), { style: 'unit', unit: 'minute', unitDisplay: 'long', maximumFractionDigits: 0 }).format(seconds / 60);
  };
  const wallet$ = a => `<a class="text-link mono" href="#advanced/creator/${esc(a)}">${esc(short(a))}</a>`;
  const empty = (title, body, action = '') => `<div class="empty compact"><h3>${esc(title)}</h3><p>${esc(body)}</p>${action}</div>`;
  const failure = message => `<div class="empty compact" role="alert"><h3>${esc(L('hub.unavailable'))}</h3><p>${esc(message)}</p><button type="button" data-hub="reload">${esc(L('retry'))}</button></div>`;
  const loading = () => `<p class="receipt-note" role="status">${esc(L('hub.loading'))}</p>`;
  const watchlist = () => { const list = read(WATCH_KEY, []); return Array.isArray(list) ? list.filter(a => ADDRESS.test(a)).slice(0, 50) : []; };

  function tabs() {
    const items = [['live', '#advanced'], ['watchlist', '#advanced/watchlist'], ['callouts', '#advanced/callouts'], ['launch', '#advanced/launch']];
    const current = ['coin', 'creator'].includes(view) ? 'live' : view;
    return `<nav class="hub-tabs" aria-label="${esc(L('hub.sections'))}">${items.map(([key, href]) => `<a href="${href}" ${current === key ? 'aria-current="page"' : ''}>${esc(L('hub.' + key))}</a>`).join('')}</nav>`;
  }
  function header(title, sub) { return `<div class="page-top"><div><h1>${esc(title)}</h1><p>${esc(sub)}</p></div></div>${tabs()}`; }

  function tape(trades, { symbol, quoteSymbol, quoteDecimals, showCoin = false } = {}) {
    if (!trades.length) return `<p class="receipt-note">${esc(L('hub.noTrades'))}</p>`;
    return `<ol class="tape">${trades.map(tr => {
      const q = QUOTES.find(x => x.symbol === (tr.quoteSymbol ?? quoteSymbol));
      const dec = tr.quoteDecimals ?? quoteDecimals ?? q?.decimals ?? 18;
      return `<li><span class="side ${tr.side}">${esc(L('hub.' + tr.side))}</span>
        <span>${showCoin ? `<a class="text-link" href="#advanced/coin/${esc(tr.token)}">${esc(tr.symbol)}</a> · ` : ''}${units(tr.tokenAmount, 18)} ${esc(showCoin ? '' : symbol ?? '')} <small>${units(tr.quoteAmount, dec)} ${esc(tr.quoteSymbol ?? quoteSymbol ?? '')}</small></span>
        <span>${tr.trader ? wallet$(tr.trader) : '—'}</span>
        <a class="text-link" href="${NETWORK.explorer}/tx/${esc(tr.txHash)}" target="_blank" rel="noopener noreferrer">${esc(ago(tr.timestamp))}<span class="sr-only"> ${esc(L('viewExplorer'))}</span></a></li>`;
    }).join('')}</ol>`;
  }

  function chart(series, quoteSymbol) {
    const points = series.filter(p => p.price > 0);
    if (points.length < 2) return `<p class="receipt-note">${esc(L('hub.noChart'))}</p>`;
    const prices = points.map(p => p.price), min = Math.min(...prices), max = Math.max(...prices), span = max - min || max || 1;
    const path = points.map((p, i) => `${(i / (points.length - 1) * 600).toFixed(1)},${(190 - (p.price - min) / span * 180).toFixed(1)}`).join(' ');
    const label = L('hub.chartSummary', { first: price(prices[0]), last: price(prices[prices.length - 1]), min: price(min), max: price(max), quote: quoteSymbol, n: points.length });
    return `<figure class="spark"><svg viewBox="0 0 600 200" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><polyline points="${path}" fill="none" stroke="currentColor" stroke-width="2.5" vector-effect="non-scaling-stroke"/></svg>
      <figcaption class="receipt-note">${esc(label)}</figcaption></figure>`;
  }

  async function load(key, path) {
    const run = epoch;
    try { data[key] = { ok: true, value: await get(path) }; } catch (error) { data[key] = { ok: false, error: error.message, status: error.status }; }
    if (run === epoch) paint();
  }

  // ---- views
  function liveView() {
    const feed = data.feed;
    let body = loading();
    if (feed && !feed.ok) body = failure(feed.error);
    else if (feed?.ok) {
      const f = feed.value;
      if (!f.launches.length) body = empty(L('hub.noLaunches'), L('hub.noLaunchesBody'), `<a class="primary-link" href="#create">${esc(L('hub.launchCta'))}</a>`);
      else body = `<div class="hub-grid"><section class="form-section"><h2>${esc(L('hub.mostActive'))}</h2><p class="receipt-note">${esc(L('hub.mostActiveHelp', { window: duration(f.windowSeconds) }))}</p>
          ${f.mostActive.length ? `<ol class="rank">${f.mostActive.map((m, i) => `<li><span class="rank-n">${i + 1}</span><a class="text-link" href="#advanced/coin/${esc(m.token)}">${esc(m.name)} <small>${esc(m.symbol)}</small></a><span>${esc(L('hub.swaps', { n: num(m.swaps) }))}</span></li>`).join('')}</ol>` : `<p class="receipt-note">${esc(L('hub.noTrades'))}</p>`}</section>
        <section class="form-section"><h2>${esc(L('hub.newLaunches'))}</h2><ol class="rank">${f.launches.slice(0, 10).map(l => `<li><a class="text-link" href="#advanced/coin/${esc(l.token)}">${esc(l.name)} <small>${esc(l.symbol)} · ${esc(l.quoteSymbol ?? '')}</small></a><span>${esc(ago(l.launchedAt))}</span><span>${wallet$(l.creator)}</span></li>`).join('')}</ol></section></div>
        <section class="form-section"><div class="section-head"><h2>${esc(L('hub.liveTrades'))}</h2><button type="button" data-hub="reload">${esc(L('refresh'))}</button></div><p class="receipt-note">${esc(L('hub.autoRefresh'))}</p>${tape(tapeAll ? f.trades : f.trades.slice(0, 12), { showCoin: true })}
        ${!tapeAll && f.trades.length > 12 ? `<div class="form-actions"><button type="button" data-hub="more">${esc(L('showMore', { n: f.trades.length - 12 }))}</button></div>` : ''}
        ${f.head ? `<p class="receipt-note">${esc(L('hub.source', { block: f.head }))}</p>` : ''}</section>`;
    }
    return header(L('hub.title'), L('hub.sub')) + `<div aria-live="polite">${body}</div>`;
  }

  function coinView() {
    const tr = data.trades, ho = data.holders, co = data.callouts;
    if (tr && !tr.ok && tr.status === 404) return header(L('hub.title'), L('hub.sub')) + empty(L('hub.notPlugged'), short(arg), `<a class="primary-link" href="#advanced">${esc(L('back'))}</a>`);
    const meta = tr?.ok ? tr.value.token : null, watching = watchlist().includes(arg.toLowerCase());
    const title = meta ? `${meta.name} (${meta.symbol})` : short(arg);
    let html = `<a class="text-link" href="#advanced">${esc(L('back'))}</a><div class="page-top coin-top"><div><h1>${esc(title)}</h1><p class="mono">${esc(arg)}</p></div>
      <div class="form-actions"><button type="button" data-hub="watch" aria-pressed="${watching}">${esc(L(watching ? 'hub.watching' : 'hub.watch'))}</button><a class="primary-link" href="#token/${esc(arg)}">${esc(L('hub.tradeLink'))}</a></div></div>${tabs()}`;
    // Trades and chart
    let market = loading();
    if (tr && !tr.ok) market = failure(tr.error);
    else if (tr?.ok) {
      const v = tr.value;
      market = `${chart(v.series, meta.quoteSymbol)}<p class="receipt-note">${esc(L('hub.chartHelp', { quote: meta.quoteSymbol }))}</p>
        <div class="section-head"><h3>${esc(L('hub.liveTrades'))} <small>${esc(L('hub.swaps', { n: num(v.totalSwaps) }))}</small></h3><button type="button" data-hub="reload">${esc(L('refresh'))}</button></div>${tape(tapeAll ? v.trades : v.trades.slice(0, 12), meta)}
        ${!tapeAll && v.trades.length > 12 ? `<div class="form-actions"><button type="button" data-hub="more">${esc(L('showMore', { n: v.trades.length - 12 }))}</button></div>` : ''}
        ${v.complete ? `<p class="receipt-note">${esc(L('hub.source', { block: v.indexedTo }))}</p>` : `<p class="callout">${esc(L('hub.indexing', { block: v.indexedTo }))}</p>`}
        <p class="receipt-note">${esc(L('hub.creator'))}: ${wallet$(meta.creator)}</p>`;
    }
    html += `<div class="hub-grid wide"><section class="form-section"><h2>${esc(L('hub.chart'))}</h2>${market}</section>`;
    // Holders
    let holders = loading();
    if (ho && !ho.ok) holders = failure(ho.error);
    else if (ho?.ok) {
      const v = ho.value;
      holders = `<p><strong>${esc(L('hub.holderCount', { n: num(v.holderCount) }))}</strong></p><p class="receipt-note">${esc(L('hub.top10', { pct: pct(v.top10WalletBps) }))}</p>
        <ol class="holders">${v.top.map(h => `<li><span>${h.label ? `<span class="tag">${esc(L('hub.' + h.label))}</span>` : ''}${h.label === 'pool' ? esc(short(h.address)) : wallet$(h.address)}</span><strong>${pct(h.bps)}</strong>
          <progress max="10000" value="${Math.min(10000, h.bps)}" aria-label="${esc(`${short(h.address)} ${pct(h.bps)}`)}"></progress></li>`).join('')}</ol>
        ${v.complete ? '' : `<p class="callout">${esc(L('hub.indexing', { block: v.indexedTo }))}</p>`}`;
    }
    html += `<section class="form-section"><h2>${esc(L('hub.holders'))}</h2>${holders}</section></div>`;
    html += `<div class="hub-grid wide">${calloutSection(co, true)}${alertSection(meta)}</div>`;
    return html;
  }

  function calloutList(co, showCoin) {
    if (!co) return loading();
    if (!co.ok) return failure(co.error);
    const list = co.value.callouts;
    if (!list.length) return `<p class="receipt-note">${esc(L('hub.noCallouts'))}</p>`;
    return `<ol class="callouts">${list.map(c => `<li><div class="callout-head">${wallet$(c.author)}${showCoin && c.coin ? ` · <a class="text-link" href="#advanced/coin/${esc(c.token)}">${esc(c.coin.symbol)}</a>` : ''}<small>${esc(ago(Date.parse(c.createdAt) / 1000))}</small></div>
      <p class="callout-text">${esc(c.text)}</p><div class="callout-foot"><small>${esc(L('hub.position'))}: ${c.position === null ? '—' : `${units(c.position, 18)} ${esc(c.coin?.symbol ?? '')}`}</small>
      <button type="button" class="quiet" data-hub="report" data-id="${esc(c.id)}">${esc(L('hub.report'))}</button></div></li>`).join('')}</ol>`;
  }

  function calloutSection(co, compose) {
    const status = co?.ok ? co.value.status : null, mode = co?.ok ? co.value.mode : null;
    let form = '';
    if (compose && mode && (mode === 'readonly' || mode === 'off')) form = `<p class="callout">${esc(L('hub.readonly'))}</p>`;
    else if (compose && mode) {
      const { account } = wallet();
      form = account ? `<form class="callout-form" data-hub-form="callout"><label class="field">${esc(L('hub.write'))}<textarea name="text" maxlength="${status.maxChars}" rows="3" required></textarea></label>
          <p class="receipt-note">${esc(L('hub.writeHelp', { n: status.maxChars }))}${mode === 'premoderated' ? ' ' + esc(L('hub.reviewNote')) : ''}</p>
          <div class="form-actions"><button type="submit" class="primary" ${calloutBusy ? 'disabled' : ''}>${esc(L('hub.post'))}</button></div></form>`
        : `<div class="form-actions"><button type="button" class="primary" data-hub="connect">${esc(L('connect'))}</button></div><p class="receipt-note">${esc(L('hub.connectToPost'))}</p>`;
    }
    return `<section class="form-section"><h2>${esc(L('hub.callouts'))}</h2><p class="receipt-note">${esc(L('hub.calloutsHelp'))}</p>${form}<p class="receipt-note" role="status" data-callout-status>${esc(calloutStatus)}</p>${calloutList(co, !compose)}</section>`;
  }

  function alerts() { const all = read(ALERT_KEY, {}); return all && typeof all === 'object' && !Array.isArray(all) ? all : {}; }
  function alertSection(meta) {
    if (!meta) return '';
    const current = alerts()[arg.toLowerCase()];
    return `<section class="form-section"><h2>${esc(L('hub.alerts'))}</h2><p class="receipt-note">${esc(L('hub.alertHelp'))}</p>
      ${current ? `<p><strong>${esc(L(current.direction === 'above' ? 'hub.above' : 'hub.below'))} ${esc(price(current.price))} ${esc(meta.quoteSymbol)}</strong></p><div class="form-actions"><button type="button" data-hub="clear-alert">${esc(L('hub.clearAlert'))}</button></div>`
        : `<form data-hub-form="alert"><div class="fields"><label class="field">${esc(L('hub.direction'))}<select name="direction"><option value="above">${esc(L('hub.above'))}</option><option value="below">${esc(L('hub.below'))}</option></select></label>
          <label class="field">${esc(L('hub.alertPrice', { quote: meta.quoteSymbol }))}<input name="price" inputmode="decimal" autocomplete="off" required pattern="[0-9]*[.,]?[0-9]+"></label></div>
          <div class="form-actions"><button type="submit">${esc(L('hub.setAlert'))}</button></div></form>`}</section>`;
  }

  function creatorView() {
    const p = data.creator, co = data.callouts;
    let launches = loading();
    if (p && !p.ok) launches = failure(p.error);
    else if (p?.ok) launches = p.value.launches.length ? `<ol class="rank">${p.value.launches.map(l => `<li><a class="text-link" href="#advanced/coin/${esc(l.token)}">${esc(l.name)} <small>${esc(l.symbol)} · ${esc(l.quoteSymbol ?? '')}</small></a><span>${esc(ago(l.launchedAt))}</span></li>`).join('')}</ol>` : `<p class="receipt-note">${esc(L('hub.noCreatorLaunches'))}</p>`;
    return `<a class="text-link" href="#advanced">${esc(L('back'))}</a><div class="page-top"><div><h1>${esc(L('hub.profileTitle', { address: short(arg) }))}</h1><p class="mono">${esc(arg)}</p></div><a class="text-link" href="${NETWORK.explorer}/address/${esc(arg)}" target="_blank" rel="noopener noreferrer">${esc(L('viewExplorer'))}</a></div>${tabs()}
      <div class="hub-grid wide"><section class="form-section"><h2>${esc(L('hub.launchesBy'))}</h2>${launches}</section>${calloutSection(co, false)}</div>`;
  }

  function watchView() {
    const list = watchlist(), m = data.markets;
    let body;
    if (!list.length) body = empty(L('hub.watchEmpty'), L('hub.watchEmptyBody'), `<a class="primary-link" href="#advanced">${esc(L('hub.live'))}</a>`);
    else if (!m) body = loading();
    else if (!m.ok) body = failure(m.error);
    else {
      const tokens = new Map(m.value.tokens.map(t => [t.address.toLowerCase(), t]));
      body = `<ol class="rank">${list.map(a => { const t = tokens.get(a); return `<li><a class="text-link" href="#advanced/coin/${esc(a)}">${t ? `${esc(t.name)} <small>${esc(t.symbol)}</small>` : esc(short(a))}</a><span>${t ? esc(t.quoteSymbol ?? '') : esc(L('hub.notPlugged'))}</span><button type="button" data-hub="unwatch" data-address="${esc(a)}">${esc(L('remove'))}</button></li>`; }).join('')}</ol><p class="receipt-note">${esc(L('hub.watchLocal'))}</p>`;
    }
    return header(L('hub.watchlist'), L('hub.watchSub')) + `<section class="form-section">${body}</section>`;
  }

  function calloutsView() { return header(L('hub.callouts'), L('hub.calloutsSub')) + `<div class="hub-grid wide">${calloutSection(data.callouts, false)}</div>`; }

  function paint() {
    if (!root?.isConnected || view === 'launch') return;
    const focus = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset?.hub ?? null : null;
    const draft = $('[data-hub-form=callout] textarea')?.value;
    root.innerHTML = `<div id="advanced-hub">${view === 'coin' ? coinView() : view === 'creator' ? creatorView() : view === 'watchlist' ? watchView() : view === 'callouts' ? calloutsView() : liveView()}</div>`;
    if (draft) { const box = $('[data-hub-form=callout] textarea'); if (box) box.value = draft; }
    if (focus) $(`[data-hub="${focus}"]`)?.focus();
  }

  function fetchAll() {
    if (view === 'live') load('feed', '/api/activity/feed');
    else if (view === 'coin') { load('trades', `/api/activity/trades?address=${arg}`); load('holders', `/api/activity/holders?address=${arg}`); load('callouts', `/api/callouts?token=${arg}`); }
    else if (view === 'creator') { load('creator', `/api/activity/creator?address=${arg}`); load('callouts', `/api/callouts?author=${arg}`); }
    else if (view === 'watchlist' && watchlist().length) load('markets', '/api/markets');
    else if (view === 'callouts') load('callouts', '/api/callouts?limit=50');
  }

  function checkAlert() {
    const v = data.trades?.ok ? data.trades.value : null, all = alerts(), key = arg?.toLowerCase(), alert = key && all[key];
    if (!v || !alert || !v.series.length) return;
    const last = v.series[v.series.length - 1].price;
    if (!(alert.direction === 'above' ? last >= alert.price : last <= alert.price)) return;
    delete all[key]; write(ALERT_KEY, all);
    const text = L('hub.alertFired', { symbol: v.token.symbol, price: price(last), quote: v.token.quoteSymbol });
    notify(text);
    try { if (globalThis.Notification?.permission === 'granted') new Notification('Plugged', { body: text, tag: `plugged-${key}` }); } catch {}
    paint();
  }

  async function poll() {
    const run = epoch;
    if (view === 'live') await load('feed', '/api/activity/feed');
    else if (view === 'coin') { await load('trades', `/api/activity/trades?address=${arg}`); if (run === epoch) checkAlert(); }
  }

  async function postCallout(form) {
    const { account, provider } = wallet(); if (!account || !provider) { await connect(); return; }
    const text = form.elements.text.value, status = $('[data-callout-status]'), run = epoch;
    calloutBusy = true; calloutStatus = L('hub.posting'); if (status) status.textContent = calloutStatus; form.querySelector('[type=submit]').disabled = true;
    try {
      const challenge = await post('/api/callouts/challenge', { account, token: arg, text });
      const hex = '0x' + [...new TextEncoder().encode(challenge.message)].map(b => b.toString(16).padStart(2, '0')).join('');
      const signature = await provider.request({ method: 'personal_sign', params: [hex, account] });
      const result = await post('/api/callouts/post', { nonce: challenge.nonce, signature });
      calloutStatus = L(result.pendingReview ? 'hub.pendingReview' : 'hub.posted');
      if (run === epoch) { form.elements.text.value = ''; await load('callouts', `/api/callouts?token=${arg}`); }
    } catch (error) { calloutStatus = error?.code === 4001 ? L('hub.signatureRejected') : error.message; }
    finally { calloutBusy = false; if (run === epoch) paint(); }
  }

  async function onClick(event) {
    const el = event.target.closest('[data-hub]'); if (!el || !root.contains(el)) return;
    const action = el.dataset.hub;
    if (action === 'reload') { data = {}; paint(); fetchAll(); }
    if (action === 'connect') await connect();
    if (action === 'more') { tapeAll = true; paint(); $('.tape li:nth-child(13) a')?.focus(); }
    if (action === 'watch') {
      const list = watchlist(), key = arg.toLowerCase(), next = list.includes(key) ? list.filter(a => a !== key) : [key, ...list].slice(0, 50);
      if (!write(WATCH_KEY, next)) notify(L('hub.storageError')); paint(); $('[data-hub=watch]')?.focus();
    }
    if (action === 'unwatch') { write(WATCH_KEY, watchlist().filter(a => a !== el.dataset.address)); paint(); }
    if (action === 'report') {
      el.disabled = true;
      try { await post('/api/callouts/report', { id: el.dataset.id }); notify(L('hub.reported')); } catch (error) { notify(error.message); el.disabled = false; }
    }
    if (action === 'clear-alert') { const all = alerts(); delete all[arg.toLowerCase()]; write(ALERT_KEY, all); paint(); }
  }

  async function onSubmit(event) {
    const form = event.target.closest('[data-hub-form]'); if (!form || !root.contains(form)) return;
    event.preventDefault();
    if (form.dataset.hubForm === 'callout') await postCallout(form);
    if (form.dataset.hubForm === 'alert') {
      const value = Number(String(form.elements.price.value).replace(',', '.'));
      if (!Number.isFinite(value) || value <= 0) { notify(L('hub.alertInvalid')); form.elements.price.focus(); return; }
      const all = alerts(); all[arg.toLowerCase()] = { direction: form.elements.direction.value === 'below' ? 'below' : 'above', price: value };
      if (!write(ALERT_KEY, all)) { notify(L('hub.storageError')); return; }
      // Permission is optional: without it the alert still shows as an in-page notice.
      try { if (globalThis.Notification?.permission === 'default') Notification.requestPermission().catch(() => {}); } catch {}
      notify(L('hub.alertSet')); paint(); checkAlert();
    }
  }

  function destroy() {
    epoch++; clearInterval(timer); timer = null; child?.destroy(); child = null;
    if (root) { root.removeEventListener('click', onClick); root.removeEventListener('submit', onSubmit); }
    root = null;
  }

  function mount(target, parts = []) {
    destroy();
    root = target; data = {}; calloutStatus = ''; tapeAll = false;
    const [sub, value] = parts;
    view = ['watchlist', 'callouts', 'launch', 'coin', 'creator'].includes(sub) ? sub : 'live';
    arg = null;
    if (view === 'coin' || view === 'creator') {
      if (!ADDRESS.test(value ?? '')) view = 'live'; else arg = value.toLowerCase();
    }
    if (view === 'launch') {
      root.innerHTML = `<div class="hub-launch">${tabs()}<div id="hub-launch-root"></div></div>`;
      child = launch; child.mount(root.querySelector('#hub-launch-root'));
      return;
    }
    root.addEventListener('click', onClick); root.addEventListener('submit', onSubmit);
    paint(); fetchAll();
    if (view === 'live' || view === 'coin') timer = setInterval(() => { if (!document.hidden) void poll(); }, POLL_MS);
  }

  return { mount, destroy, invalidate() { if (view === 'launch') child?.invalidate(); else paint(); }, title() { return view === 'launch' ? 'advancedLaunch.advancedLaunch' : 'hub.title'; } };
}
