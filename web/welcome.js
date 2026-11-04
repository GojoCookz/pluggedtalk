// First-visit sign-in screen. Only real actions are enabled: wallet connect, browsing, and any
// social provider the server reports configured with a start URL (none today).
const PROVIDERS = [['x','X'],['tiktok','TikTok'],['kick','Kick'],['github','GitHub'],['google','Google'],['email',null],['apple','Apple']];
const glyphs = {
  x:'<path class="fill" d="M18.9 1.2h3.7l-8 9.2 9.4 12.5h-7.4l-5.8-7.6-6.6 7.6H.5l8.6-9.8L0 1.2h7.6l5.2 6.9Zm-1.3 19.4h2L6.5 3.2H4.3Z"/>',
  tiktok:'<path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5M14 3c.6 2.5 2.4 4 5 4.2"/>',
  kick:'<path class="fill" d="M4 3h5v6h2V7h2V5h2V3h5v6h-2v2h-2v2h2v2h2v6h-5v-2h-2v-2h-2v-2H9v6H4Z"/>',
  github:'<path d="M9 19c-4 1.5-4-2-6-2.5m12 5v-3.5a3 3 0 0 0-.9-2.4c3 0 6-1.5 6-6.6a5 5 0 0 0-1.4-3.5 4.6 4.6 0 0 0-.1-3.5s-1.1-.3-3.6 1.4a12.3 12.3 0 0 0-6.5 0C6 1.7 4.9 2 4.9 2a4.6 4.6 0 0 0-.1 3.5A5 5 0 0 0 3.4 9c0 5.1 3 6.6 6 6.6a3 3 0 0 0-.9 2.4V21.5"/>',
  google:'<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6M20.5 12H12"/>',
  email:'<path d="M3 5h18v14H3ZM3.5 6l8.5 7 8.5-7"/>',
  apple:'<path d="M12 7.5c-1.6-1.2-5.3-1.3-6.4 2.4-1 3.4.8 8.5 3.1 10.1 1 .7 2 .3 3.3-.2 1.3.5 2.3.9 3.3.2 1.4-1 2.6-3.1 3.2-5.1-2-1-2.7-3.8-.8-5.6-1.4-2-4.1-2.6-5.7-1.8ZM12 7.5c-.2-2.2 1.2-4 3-4.5"/>',
  wallet:'<path d="M4 7h16v13H4ZM4 7V4h13v3M16 12h4v4h-4Z"/>',
  chevron:'<path d="m6 9 6 6 6-6"/>', arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
};
const glyph = name => `<svg class="wl-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${glyphs[name]}</svg>`;

export function welcomeScreen({t, esc, connect, wallet}) {
  let providers = null, expanded = false, request = null;
  async function load() {
    try {
      const response = await fetch('/api/auth/providers', {signal:AbortSignal.timeout(10000)});
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const data = await response.json();
      providers = new Map((Array.isArray(data.providers) ? data.providers : []).filter(p => p?.configured === true && typeof p.startUrl === 'string' && p.startUrl.startsWith('/')).map(p => [p.id, p.startUrl]));
    } catch { providers = new Map(); }
  }
  function options() {
    const ready = providers?.size ?? 0;
    return `${ready === PROVIDERS.length ? '' : `<p class="wl-soon-note" id="wl-soon-note">${esc(t('welcome.soonNote'))}</p>`}<ul class="wl-options" role="list">${PROVIDERS.map(([id,brand]) => {
      const label = esc(t('welcome.with',{name:brand ?? t('welcome.email')})), url = providers?.get(id);
      return `<li>${url ? `<a class="wl-option" href="${esc(url)}">${glyph(id)}<span>${label}</span></a>`
        : `<button type="button" class="wl-option" disabled aria-describedby="wl-soon-note">${glyph(id)}<span>${label}</span><span class="wl-pill">${esc(t('welcome.soon'))}</span></button>`}</li>`;
    }).join('')}</ul>`;
  }
  function paint(root) {
    root.innerHTML = `<div class="welcome"><img class="wl-mark" src="/mark.svg" width="56" height="56" alt="Plugged">
      <section class="wl-card" aria-labelledby="wl-title"><h1 id="wl-title">${esc(t('welcome.title'))}</h1><p class="wl-sub">${esc(t('welcome.sub'))}</p>
      <button type="button" class="wl-primary" data-welcome-connect>${glyph('wallet')}<span>${esc(t('connect'))}</span></button>
      <p class="wl-note">${esc(t('welcome.walletNote'))}</p>
      <button type="button" class="wl-toggle" data-welcome-more aria-expanded="${expanded}" aria-controls="wl-more"><span>${esc(t(expanded ? 'welcome.fewer':'welcome.more'))}</span>${glyph('chevron')}</button>
      <div id="wl-more" ${expanded ? '' : 'hidden'}>${expanded ? options() : ''}</div>
      <a class="wl-browse" href="#discover" data-welcome-browse><span>${esc(t('welcome.browse'))}</span>${glyph('arrow')}</a></section>
      <nav class="wl-footer" aria-label="${esc(t('welcome.footer'))}"><a href="#terms">${esc(t('welcome.terms'))}</a><a href="#privacy">${esc(t('welcome.privacy'))}</a><a href="#guide">${esc(t('welcome.docs'))}</a></nav></div>`;
  }
  let root = null;
  const onClick = async event => {
    const el = event.target.closest('[data-welcome-connect],[data-welcome-more]'); if (!el || !root?.contains(el)) return;
    if (el.hasAttribute('data-welcome-connect')) { if (wallet().account) location.hash = 'discover'; else connect(); return; }
    expanded = !expanded;
    if (expanded && !providers) { request ??= load(); await request; if (!root) return; }
    paint(root); root.querySelector('[data-welcome-more]').focus();
  };
  return {
    mount(target) { root = target; paint(root); request ??= load(); document.addEventListener('click', onClick); },
    invalidate() {},
    destroy() { document.removeEventListener('click', onClick); root = null; },
  };
}

export function legalScreen({t, esc}) {
  return { mount(root, kind) {
    root.innerHTML = `<article class="legal"><a class="text-link" href="#welcome">${esc(t('back'))}</a><h1>${esc(t(kind === 'terms' ? 'legal.termsTitle':'legal.privacyTitle'))}</h1>
      <p class="callout"><strong>${esc(t('legal.draft'))}</strong></p><p>${esc(t(kind === 'terms' ? 'legal.termsBody':'legal.privacyBody'))}</p></article>`;
  }, invalidate() {}, destroy() {} };
}
